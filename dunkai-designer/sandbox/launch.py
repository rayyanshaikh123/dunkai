"""Fail-closed Linux evaluator sandbox without user namespaces.

Landlock ABI >= 3 confines files; libseccomp uses a syscall allowlist.
Only the trusted Node executable can execute. No sockets, other processes,
provider environment, /proc process memory, or writable application sources.
"""
import ctypes as C
import ctypes.util
import errno
import json
import os
from pathlib import Path
import platform
import resource
import subprocess
import sys
import tempfile

READ_FILE, READ_DIR, EXECUTE = 4, 8, 1
WRITE = (1 << 1) | sum(1 << bit for bit in range(4, 15))
# Includes REFER (ABI 2) and TRUNCATE (ABI 3), excluding EXECUTE.
HANDLED = (1 << 15) - 1


class Ruleset(C.Structure):
    _fields_ = [("handled_access_fs", C.c_uint64)]


class Beneath(C.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", C.c_uint64), ("parent_fd", C.c_int32)]


class Compare(C.Structure):
    _fields_ = [("arg", C.c_uint), ("op", C.c_int), ("a", C.c_uint64), ("b", C.c_uint64)]


def checked(result, operation):
    if result < 0:
        number = C.get_errno()
        raise OSError(number, operation + ": " + os.strerror(number))
    return result


def confine(node, designer, work, scratch):
    if sys.platform != "linux" or platform.machine() not in ("x86_64", "aarch64"):
        raise RuntimeError("Landlock launcher requires Linux x86_64 or arm64")
    library = ctypes.util.find_library("seccomp")
    if not library: raise RuntimeError("libseccomp is unavailable")
    sc = C.CDLL(library, use_errno=True)
    libc = C.CDLL(None, use_errno=True)
    libc.syscall.restype = C.c_long
    abi = checked(libc.syscall(444, 0, 0, 1), "Landlock ABI query")
    if abi < 3: raise RuntimeError("Landlock ABI 3 or newer is required")
    ruleset = Ruleset(HANDLED)
    descriptor = checked(libc.syscall(444, C.byref(ruleset), C.sizeof(ruleset), 0), "Landlock create")
    try:
        def allow(name, rights):
            location = Path(name).resolve(strict=True)
            if location.is_file(): rights &= READ_FILE | EXECUTE | (1 << 1) | (1 << 14)
            fd = os.open(location, os.O_PATH | os.O_CLOEXEC)
            try:
                rule = Beneath(rights, fd)
                checked(libc.syscall(445, descriptor, 1, C.byref(rule), 0), "Landlock rule")
            finally: os.close(fd)
        for name in ("/usr", "/lib", "/lib64", designer):
            if Path(name).exists(): allow(name, READ_FILE | READ_DIR)
        allow(node, READ_FILE | EXECUTE)
        # execve also checks EXECUTE on the ELF interpreter, not only Node.
        # Shared libraries remain read-only and other executables stay denied.
        loader = {"x86_64": "/lib64/ld-linux-x86-64.so.2", "aarch64": "/lib/ld-linux-aarch64.so.1"}[platform.machine()]
        allow(loader, READ_FILE | EXECUTE)
        for name in (work, scratch): allow(name, READ_FILE | READ_DIR | WRITE)
        for name in ("/dev/null", "/dev/urandom", "/dev/random"):
            allow(name, READ_FILE | (1 << 1))
        # Node may inspect host memory/CPU counts; no process directories exposed.
        for name in ("/proc/meminfo", "/proc/cpuinfo", "/proc/self/stat"):
            if Path(name).exists(): allow(name, READ_FILE)
        checked(libc.prctl(38, 1, 0, 0, 0), "no_new_privs")
        checked(libc.syscall(446, descriptor, 0), "Landlock restrict")
    finally: os.close(descriptor)

    sc.seccomp_init.argtypes = [C.c_uint32]; sc.seccomp_init.restype = C.c_void_p
    sc.seccomp_syscall_resolve_name.argtypes = [C.c_char_p]; sc.seccomp_syscall_resolve_name.restype = C.c_int
    sc.seccomp_rule_add_array.argtypes = [C.c_void_p, C.c_uint32, C.c_int, C.c_uint, C.POINTER(Compare)]
    sc.seccomp_load.argtypes = [C.c_void_p]; sc.seccomp_release.argtypes = [C.c_void_p]
    deny = 0x00050000 | errno.EPERM
    allow_action = 0x7fff0000
    context = sc.seccomp_init(deny)
    if not context: raise RuntimeError("seccomp initialization failed")
    def rule(name, action=allow_action, comparisons=()):
        number = sc.seccomp_syscall_resolve_name(name.encode())
        if number < 0: return
        array = (Compare * len(comparisons))(*comparisons) if comparisons else None
        result = sc.seccomp_rule_add_array(context, action, number, len(comparisons), array)
        if result < 0: raise RuntimeError("seccomp rule failed: " + name)
    # File syscalls are additionally subject to the Landlock rules above.
    allowed = """read write readv writev pread64 pwrite64 preadv pwritev preadv2 pwritev2
        close close_range open openat openat2 stat lstat fstat newfstatat statx
        access faccessat faccessat2 lseek getdents getdents64 readlink readlinkat
        mkdir mkdirat rmdir unlink unlinkat rename renameat renameat2
        link linkat symlink symlinkat ftruncate truncate fsync fdatasync
        getcwd chdir fchdir umask
        fcntl flock dup dup2 dup3 pipe pipe2 sendfile copy_file_range
        mmap mprotect munmap mremap madvise brk msync mincore
        rt_sigaction rt_sigprocmask rt_sigreturn rt_sigpending rt_sigtimedwait sigaltstack
        futex futex_waitv set_robust_list get_robust_list rseq membarrier
        arch_prctl set_tid_address getpid getppid gettid getuid geteuid getgid getegid getgroups
        clock_gettime clock_getres clock_nanosleep nanosleep gettimeofday time times
        getrusage getrlimit sched_getaffinity sched_yield sched_getparam sched_getscheduler
        sched_get_priority_max sched_get_priority_min getcpu uname sysinfo getrandom
        epoll_create epoll_create1 epoll_ctl epoll_wait epoll_pwait epoll_pwait2
        eventfd eventfd2 poll ppoll select pselect6 restart_syscall
        statfs fstatfs wait4 waitid execve exit exit_group"""
    try:
        for name in allowed.split(): rule(name)
        # Only terminal/pipe status ioctls; file metadata mutation is denied.
        for operation in (0x5401, 0x5413, 0x541b, 0x5421):
            rule("ioctl", comparisons=(Compare(1, 4, operation, 0),))
        # Thread creation is allowed; fork, vfork and process clones are denied.
        flags = 0x100 | 0x800 | 0x10000  # CLONE_VM | CLONE_SIGHAND | CLONE_THREAD
        rule("clone", comparisons=(Compare(0, 7, flags, flags),))
        # glibc must fall back to clone, whose flags we can inspect.
        rule("clone3", 0x00050000 | errno.ENOSYS)
        rule("tgkill", comparisons=(Compare(0, 4, os.getpid(), 0),))
        # Unlike getrlimit, prlimit64 can change another same-UID process.
        rule("prlimit64", comparisons=(Compare(0, 4, 0, 0),))
        rule("prlimit64", comparisons=(Compare(0, 4, os.getpid(), 0),))
        if sc.seccomp_load(context) < 0: raise RuntimeError("seccomp load failed")
    finally: sc.seccomp_release(context)


def execute(node, designer, work, arguments):
    print("PCB sandbox: preparing isolated compiler", file=sys.stderr, flush=True)
    node, designer, work = (str(Path(value).resolve(strict=True)) for value in (node, designer, work))
    # Scratch is private to this evaluator, and cannot contain any host secrets.
    scratch = tempfile.mkdtemp(prefix=".sandbox-", dir=work)
    resource.setrlimit(resource.RLIMIT_CPU, (180, 180))
    resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    os.chdir(designer)
    # Set a finite wall-clock limit in the parent (spawnSync).
    environment = {"PATH": "/usr/bin:/bin", "HOME": scratch, "TMPDIR": scratch, "NODE_ENV": "production", "OPENSSL_CONF": "/dev/null"}
    os.environ.clear(); os.environ.update(environment)
    confine(node, designer, work, scratch)
    print("PCB sandbox: restrictions applied; starting Node", file=sys.stderr, flush=True)
    os.execve(node, [node, "--max-old-space-size=1024", *arguments], environment)


def probe(node, designer):
    """Check real enforcement using the same launcher as the PCB evaluator."""
    with tempfile.TemporaryDirectory(prefix="dunkai-sandbox-check-") as temporary:
        work = Path(temporary) / "work"; work.mkdir()
        secret = Path(temporary) / "outside-secret"; secret.write_text("not-readable")
        (work / "escape").symlink_to(secret)
        script = """
const fs = require('node:fs'), net = require('node:net'), cp = require('node:child_process');
const work = process.argv[1], secret = process.argv[2], designer = process.argv[3];
function denied(fn) { try { fn(); throw Error('Sandbox allowed forbidden operation'); }
catch(e) { if (!['EACCES','EPERM'].includes(e.code)) throw e; } }
fs.writeFileSync(work + '/allowed', 'ok');
denied(() => fs.readFileSync(secret));
denied(() => fs.readFileSync(work + '/escape'));
denied(() => fs.writeFileSync(designer + '/.sandbox-forbidden', 'bad'));
denied(() => fs.truncateSync(secret, 0));
denied(() => fs.chmodSync(designer, 0o777));
if (process.env.GROQ_API_KEY || process.env.HF_TOKEN_WRITE) throw Error('Environment leaked');
const child = cp.spawnSync(process.execPath, ['-e', 'process.exit(0)']);
if (!child.error || !['EPERM','EACCES'].includes(child.error.code)) throw Error('Child process allowed');
const socket = net.connect(443, '1.1.1.1');
socket.on('connect', () => { throw Error('Network allowed'); });
socket.on('error', (e) => { if (!['EPERM','EACCES'].includes(e.code)) throw e;
const {Worker} = require('node:worker_threads');
const worker = new Worker('require("node:fs").writeFileSync(' + JSON.stringify(work + '/thread') + ', "ok")', {eval:true});
worker.on('error', e => {throw e}); worker.on('exit', code => {if(code)process.exit(code); console.log('sandbox-enforced');}); });
"""
        command = [sys.executable, str(Path(__file__).resolve()), "run", str(node), str(designer), str(work),
                   "-e", script, str(work), str(secret), str(designer)]
        result = subprocess.run(command, capture_output=True, text=True, timeout=20,
                                env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")})
        if result.returncode or "sandbox-enforced" not in result.stdout:
            raise RuntimeError((result.stderr.strip() or "Enforcement probe failed")[-500:])
        (work / "index.tsx").write_text('export default () => <board width="20mm" height="20mm"><resistor name="R1" resistance="1k" footprint="0402" /></board>')
        evaluator = Path(designer) / "src/stages/e-worker.mjs"
        compilation = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "run", str(node), str(designer), str(work), str(evaluator), str(work)],
            capture_output=True, text=True, timeout=120,
            env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")})
        if compilation.returncode or not all((work / "dist" / filename).is_file()
                                            for filename in ("circuit.json", "schematic.svg", "pcb.svg")):
            raise RuntimeError((compilation.stderr.strip() or "Sandboxed PCB compiler check failed")[-500:])
    return "landlock-seccomp enforcement and PCB compiler passed"


if __name__ == "__main__":
    try:
        if sys.argv[1] == "probe": print(probe(Path(sys.argv[2]), Path(sys.argv[3])))
        elif sys.argv[1] == "run": execute(*sys.argv[2:5], sys.argv[5:])
        else: raise RuntimeError("Unknown sandbox action")
    except Exception as error:
        print("Sandbox unavailable: " + str(error), file=sys.stderr)
        sys.exit(1)
