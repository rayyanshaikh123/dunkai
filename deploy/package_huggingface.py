"""Build the Space from an allowlist. No credentials, data or dependencies."""
import json
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DESTINATION = ROOT / "deploy/dist/huggingface-engine"


def build():
    if DESTINATION.exists(): shutil.rmtree(DESTINATION)
    DESTINATION.mkdir(parents=True)
    files = []
    def add(source, target=None):
        relative = Path(target or source)
        destination = DESTINATION / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / source, destination)
        files.append(relative.as_posix())
    for directory, extensions in [("ai_engine/agents", {".py", ".json", ".txt"}),
                                   ("ai_engine/data/profiles", {".json"}),
                                   ("dunkai-designer/src", {".mjs", ".js", ".ts", ".json"})]:
        for file in sorted((ROOT / directory).rglob("*")):
            if not file.is_file() or file.suffix not in extensions: continue
            if any(part.startswith((".", "test", "__pycache__")) for part in file.relative_to(ROOT / directory).parts): continue
            add(file.relative_to(ROOT).as_posix())
    for file in ["ai_engine/requirements.txt", "dunkai-designer/package.json", "dunkai-designer/package-lock.json", "dunkai-designer/.npmrc"]: add(file)
    for name in ["README.md", "app.py", "adapter.py", "bootstrap.py", "requirements.txt", "packages.txt"]:
        add("deploy/huggingface-engine/" + name, name)
    (DESTINATION / ".gitignore").write_text(".env\n.env.*\n__pycache__/\n*.pyc\nnode_modules/\n.cache/\n*.log\n")
    files.append(".gitignore")
    forbidden = {".env", "runtime.env", "node_modules", "venv", ".venv", "shortlist-log.jsonl"}
    assert not any(forbidden.intersection(Path(name).parts) for name in files)
    output = ROOT / "deploy/dist/dunkai-hf-engine.zip"
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in files: archive.write(DESTINATION / name, name)
    with zipfile.ZipFile(output) as archive: assert archive.testzip() is None
    print(json.dumps({"bundle": str(output.relative_to(ROOT)), "files": len(files)}))
    return DESTINATION


if __name__ == "__main__": build()
