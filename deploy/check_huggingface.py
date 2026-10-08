"""Check hosted connections without provider calls or printing credentials."""
import json
from pathlib import Path
import urllib.request
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent


def main():
    config = dotenv_values(ROOT / 'backend/.env.local')
    headers = {'x-supervisor-token': config.get('SUPERVISOR_AGENT_TOKEN', '')}
    reader = config.get('SUPERVISOR_HF_TOKEN')
    if reader: headers['authorization'] = 'Bearer ' + reader
    origin = config.get('SUPERVISOR_AGENT_URL', '').rstrip('/')
    if not origin: raise SystemExit('Run deploy/connect_huggingface.py first')
    try:
        for label, url in [('Node backend', 'https://dunkai.onrender.com/health'), ('AI engine', origin + '/health')]:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers if label == 'AI engine' else {}), timeout=60) as response:
                body = json.load(response)
                print(label + ': HTTP ' + str(response.status))
                if label == 'AI engine':
                    print('PCB ready:', body.get('pcb_ready'))
                    print('PCB check:', body.get('pcb_reason'))
                    print('Full PCB workflow validated:', body.get('complete_pcb_run_validated'))
        with urllib.request.urlopen(urllib.request.Request(origin + '/api/v1/supervisor/capabilities', headers=headers), timeout=30) as response:
            caps = json.load(response).get('data', {})
            print('Engine authentication: passed')
            print('Groq PCB available:', caps.get('board_providers', {}).get('groq'))
    except Exception as error:
        raise SystemExit('Connection check failed: ' + type(error).__name__)


if __name__ == '__main__': main()
