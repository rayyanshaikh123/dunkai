"""Install an official Node 22 distribution without root or provider secrets."""
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
from pathlib import Path


def install_designer(root: Path, state: Path):
    designer = root / "dunkai-designer"
    node_root = state / "node"
    node_root.mkdir(parents=True, exist_ok=True)
    marker = node_root / "active"
    binary = Path(marker.read_text().strip()) / "bin" / "node" if marker.exists() else None
    if not binary or not binary.is_file():
        with urllib.request.urlopen("https://nodejs.org/dist/index.json", timeout=30) as response:
            releases = json.load(response)
        version = next(item["version"] for item in releases if re.fullmatch(r"v22\.\d+\.\d+", item["version"]))
        arch = {"x86_64": "x64", "aarch64": "arm64"}.get(platform.machine())
        if not arch: raise RuntimeError("The Space's CPU architecture is unsupported")
        filename = f"node-{version}-linux-{arch}.tar.xz"
        base = f"https://nodejs.org/dist/{version}/"
        with urllib.request.urlopen(base + "SHASUMS256.txt", timeout=30) as response:
            checksums = dict(line.split()[::-1] for line in response.read().decode().splitlines())
        with tempfile.TemporaryDirectory(dir=node_root) as temporary:
            archive = Path(temporary) / filename
            digest = hashlib.sha256()
            with urllib.request.urlopen(base + filename, timeout=120) as response, archive.open("wb") as output:
                while chunk := response.read(1024 * 1024): output.write(chunk); digest.update(chunk)
            if digest.hexdigest() != checksums[filename]: raise RuntimeError("Node archive checksum mismatch")
            with tarfile.open(archive) as package: package.extractall(node_root, filter="data")
        directory = node_root / filename.removesuffix(".tar.xz")
        marker.write_text(str(directory)); binary = directory / "bin" / "node"
    environment = {"PATH": str(binary.parent) + ":/usr/local/bin:/usr/bin:/bin",
                   "HOME": str(state), "NODE_ENV": "production", "npm_config_cache": str(state / "npm-cache")}
    lock_digest = hashlib.sha256((designer / "package-lock.json").read_bytes() + (designer / "package.json").read_bytes()).hexdigest()
    installed = state / "designer-lock"
    if not (designer / "node_modules").is_dir() or not installed.exists() or installed.read_text() != lock_digest:
        npm = binary.parent.parent / "lib/node_modules/npm/bin/npm-cli.js"
        subprocess.run([str(binary), str(npm), "ci", "--omit=dev", "--legacy-peer-deps"], cwd=designer,
                       env=environment, check=True, timeout=1200)
        installed.write_text(lock_digest)
    os.environ["PATH"] = environment["PATH"]
    return binary


def sandbox_status(binary: Path, designer: Path):
    bwrap = shutil.which("bwrap")
    if not bwrap: return False, "bubblewrap is unavailable"
    arguments = [bwrap, "--unshare-all", "--die-with-parent", "--new-session",
                 "--ro-bind", "/usr", "/usr", "--ro-bind-try", "/lib", "/lib",
                 "--ro-bind-try", "/lib64", "/lib64", "--ro-bind", str(designer), str(designer),
                 "--ro-bind", str(binary), str(binary), "--proc", "/proc", "--dev", "/dev",
                 "--", str(binary), "-e", "process.exit(0)"]
    try:
        result = subprocess.run(arguments, capture_output=True, text=True, timeout=15,
                                env={"PATH": "/usr/local/bin:/usr/bin:/bin"})
        return result.returncode == 0, "passed" if result.returncode == 0 else result.stderr.strip()[-500:]
    except (OSError, subprocess.TimeoutExpired) as error:
        return False, type(error).__name__
