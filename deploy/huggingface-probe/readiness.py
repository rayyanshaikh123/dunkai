"""Small, secret-free prerequisite check; does not execute generated code."""
import os
import shutil
import subprocess


def _run(arguments):
    try:
        result = subprocess.run(
            arguments, capture_output=True, text=True, timeout=10,
            env={"PATH": "/usr/local/bin:/usr/bin:/bin"},
        )
        return result.returncode, result.stdout.strip(), result.stderr.strip()
    except (OSError, subprocess.TimeoutExpired) as error:
        return -1, "", type(error).__name__


def inspect_runtime():
    node = shutil.which("node")
    code, version, _ = _run([node, "--version"]) if node else (-1, "", "")
    try:
        node_ok = code == 0 and int(version.lstrip("v").split(".")[0]) >= 22
    except ValueError:
        node_ok = False
    bwrap = shutil.which("bwrap")
    if bwrap:
        code, _, detail = _run([
            bwrap, "--unshare-all", "--die-with-parent",
            "--ro-bind", "/usr", "/usr", "--ro-bind-try", "/lib", "/lib",
            "--ro-bind-try", "/lib64", "/lib64", "--symlink", "usr/bin", "/bin",
            "--proc", "/proc", "--dev", "/dev", "--", "/usr/bin/true",
        ])
        sandbox_ok = code == 0
    else:
        sandbox_ok, detail = False, "bubblewrap is not installed"
    return {
        "node_version": version or "not available",
        "node_22_or_newer": node_ok,
        "pcb_sandbox_preflight_passed": sandbox_ok,
        "sandbox_detail": "passed" if sandbox_ok else detail[-500:],
        "prerequisites_passed": node_ok and sandbox_ok,
        "complete_engine_tested": False,
        "runs_as_root": os.getuid() == 0,
    }
