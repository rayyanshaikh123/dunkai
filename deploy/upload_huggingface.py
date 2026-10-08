"""Upload the reviewed source bundle and set secrets without displaying them."""
from pathlib import Path
from dotenv import dotenv_values
from huggingface_hub import HfApi
from package_huggingface import ROOT, DESTINATION


def main():
    engine = dotenv_values(ROOT / "ai_engine/.env")
    backend = dotenv_values(ROOT / "backend/.env.local")
    token = engine.get("HF_TOKEN_WRITE")
    if not token: raise SystemExit("Set HF_TOKEN_WRITE in ai_engine/.env; do not put it on the command line")
    if not (DESTINATION / "app.py").is_file(): raise SystemExit("Build the source bundle first")
    supervisor = backend.get("SUPERVISOR_AGENT_TOKEN") or engine.get("SUPERVISOR_AGENT_TOKEN")
    if not supervisor or len(supervisor) < 32: raise SystemExit("Configure a strong shared SUPERVISOR_AGENT_TOKEN before uploading")
    api = HfApi(token=token)
    space = "rayyanshk/dunkai"
    info = api.space_info(space)
    if info.sdk != "gradio": raise SystemExit("The target Space must use the Gradio SDK")
    secrets = {"SUPERVISOR_AGENT_TOKEN": supervisor,
               "GROQ_API_KEY": engine.get("GROQ_API_KEY") or backend.get("GROQ_API_KEY"),
               "HF_TOKEN_READ": engine.get("HF_TOKEN_READ") or backend.get("HF_TOKEN_READ")}
    for name, value in secrets.items():
        if not value: raise SystemExit("Missing required secret: " + name)
        api.add_space_secret(space, name, value)
    api.add_space_variable(space, "DESIGNER_PROVIDER", "groq")
    api.add_space_variable(space, "GROQ_MODEL", "openai/gpt-oss-120b")
    # Inspect every actual upload entry. An old .env cannot slip in through a
    # newly added file in the generated staging folder.
    files = [file for file in DESTINATION.rglob("*") if file.is_file()]
    for file in files:
        relative = file.relative_to(DESTINATION)
        if any(part in {".env", "node_modules", "venv", ".venv"} or part.startswith(".env.") for part in relative.parts):
            raise SystemExit("Forbidden upload entry")
        content = file.read_bytes()
        if any(value.encode() in content for value in [token, *secrets.values()] if value):
            raise SystemExit("Credential found in upload content; refusing upload")
    commit = api.upload_folder(repo_id=space, repo_type="space", folder_path=str(DESTINATION),
                               commit_message="Deploy original DunkAI engine with authenticated Gradio adapter")
    print("Uploaded", len(files), "source files to", space)
    print("Commit:", commit.oid)
    print("Space: https://huggingface.co/spaces/" + space)


if __name__ == "__main__": main()
