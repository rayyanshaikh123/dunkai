"""Prepare dashboard environment files; credentials stay local and ignored."""
import os
from pathlib import Path
from dotenv import dotenv_values, set_key

ROOT = Path(__file__).resolve().parent.parent


def main():
    engine = dotenv_values(ROOT / 'ai_engine/.env')
    backend_path = ROOT / 'backend/.env.local'
    backend = dotenv_values(backend_path)
    supervisor = backend.get('SUPERVISOR_AGENT_TOKEN') or engine.get('SUPERVISOR_AGENT_TOKEN')
    reader = engine.get('HF_TOKEN_READ') or backend.get('HF_TOKEN_READ') or engine.get('HF_TOKEN')
    if not supervisor or len(supervisor) < 32: raise SystemExit('Shared supervisor secret is missing')
    if not reader: raise SystemExit('HF read token is missing')
    settings = {
        'SUPERVISOR_AGENT_URL': 'https://rayyanshk-dunkai.hf.space',
        'SUPERVISOR_AGENT_PATH': '/api/v1/supervisor',
        'SUPERVISOR_AGENT_TOKEN': supervisor,
        'SUPERVISOR_HF_TOKEN': reader,
        'LOCAL_RUNTIME_ENABLED': 'false',
        'ARCHIVE_SUPERVISOR_ARTIFACTS': 'true',
        'AI_QUEUE_ENABLED': 'false',
        'BILLING_ENABLED': 'false',
        'CREDIT_METERING_ENABLED': 'true',
        'DISABLE_CREDITS_FOR_TESTING': 'false',
        'FRONTEND_URL': 'https://dunkai.vercel.app',
        'CLIENT_ORIGIN': 'https://dunkai.vercel.app',
    }
    for name, value in settings.items(): set_key(backend_path, name, value, quote_mode='never')
    os.chmod(backend_path, 0o600)
    destination = ROOT / 'deploy/dist'
    destination.mkdir(parents=True, exist_ok=True)
    render = destination / 'render-huggingface.env'
    # Create with restricted permissions before writing any credential bytes.
    fd = os.open(render, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as output:
        for name, value in settings.items(): output.write(f'{name}={value}\n')
    (destination / 'vercel-huggingface.env').write_text(
        'BACKEND_URL=https://dunkai.onrender.com\n'
        'NEXT_PUBLIC_BACKEND_URL=https://dunkai.onrender.com\n'
        'NEXT_PUBLIC_SITE_URL=https://dunkai.vercel.app\n')
    print('Prepared deploy/dist/render-huggingface.env (private; contains secrets)')
    print('Prepared deploy/dist/vercel-huggingface.env')
    print('Updated backend/.env.local; backend/.env development settings were preserved')
    print('Import these files into the respective hosting dashboards, then redeploy')


if __name__ == '__main__': main()
