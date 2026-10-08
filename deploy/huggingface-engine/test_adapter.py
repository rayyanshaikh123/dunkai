import asyncio
import csv
import importlib.util
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import httpx

from adapter import EngineProcess, create_app, localize_payload


class FakeEngine:
    def __init__(self, directory):
        self.state = Path(directory)
        self.origin = "http://original-engine.test"
        self.starts = self.stops = 0
    async def start(self): self.starts += 1
    async def stop(self): self.stops += 1


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_no_auth_or_denied_sandbox_never_starts_the_engine(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = FakeEngine(directory)
            app = create_app(engine, "shared-secret", pcb_ready=False, pcb_reason="Namespace denied")
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://space.test") as client:
                response = await client.post("/api/v1/supervisor/stream", json={"action": "generate_board"})
                self.assertEqual(response.status_code, 401)
                response = await client.post("/api/v1/supervisor/stream", headers={"x-supervisor-token": "shared-secret"}, json={"action": "generate_board"})
                self.assertEqual(response.status_code, 503)
                self.assertEqual(engine.starts, 0)
                caps = await client.get("/api/v1/supervisor/capabilities", headers={"authorization": "Bearer shared-secret"})
                self.assertFalse(caps.json()["data"]["board_providers"]["groq"])

    async def test_busy_instance_rejects_a_second_design_and_blocks_artifact_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = FakeEngine(directory); app = create_app(engine, "shared-secret", pcb_ready=True)
            app.state.busy = True
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://space.test") as client:
                response = await client.post("/api/v1/supervisor/stream", headers={"authorization": "Bearer shared-secret"}, json={"action": "run_workflow"})
                self.assertEqual(response.status_code, 429)
                self.assertEqual(response.headers["retry-after"], "10")
                private = Path(directory) / "private"; private.write_text("secret")
                (Path(directory) / "boards" / "escape").symlink_to(private)
                response = await client.get("/api/v1/supervisor/artifacts/escape", headers={"authorization": "Bearer shared-secret"})
                self.assertEqual(response.status_code, 404)

    def test_saved_bom_is_localized_without_mutating_the_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            payload = {"project": {"bom": {"rows": [{"reference": "U1", "mfr_part": 'Part,"quoted"', "lcsc": "C123", "build_quantity": 2}]}}}
            localized = localize_payload(payload, directory)
            self.assertNotIn("bom_csv_path", payload["project"])
            file = Path(localized["project"]["bom_csv_path"])
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            with file.open() as source: row = next(csv.DictReader(source))
            self.assertEqual(row["mfr_part"], 'Part,"quoted"')
            self.assertEqual(localize_payload({"project": {"bom": None}}, directory), {"project": {"bom": None}})

    @unittest.skipUnless(os.environ.get("DUNKAI_NATIVE_TEST") == "true", "Opt-in real Python engine check")
    async def test_original_requirements_agent_streams_through_the_space_adapter(self):
        requests = []
        class ModelResponse(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append(body)
                content = ({"status": "question", "question": "How should this sensor board be powered?",
                            "options": ["USB", "Battery"], "selection_mode": "multiple", "requirements": None}
                           if body.get("response_format", {}).get("type") == "json_schema"
                           else {"verdict": "allow", "category": "benign", "confidence": 1, "reasoning": "Sensor board"})
                output = json.dumps({"id": "test", "object": "chat.completion", "created": 1,
                                     "model": body["model"], "choices": [{"index": 0, "message": {"role": "assistant", "content": json.dumps(content)}, "finish_reason": "stop"}],
                                     "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20}}).encode()
                self.send_response(200); self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(output))); self.end_headers(); self.wfile.write(output)
        mock = ThreadingHTTPServer(("127.0.0.1", 0), ModelResponse)
        thread = threading.Thread(target=mock.serve_forever, daemon=True); thread.start()
        root = Path(__file__).resolve().parents[2]
        try:
            with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
                    "GROQ_API_KEY": "gsk_mock", "GROQ_API_BASE": f"http://127.0.0.1:{mock.server_port}",
                    "GROQ_MODEL": "openai/gpt-oss-120b"}):
                engine = EngineProcess(root, directory, "shared-secret")
                app = create_app(engine, "shared-secret")
                try:
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://space.test", timeout=90) as client:
                        response = await client.post("/api/v1/supervisor/stream", headers={"x-supervisor-token": "shared-secret"},
                                                     json={"action": "run_workflow", "project": {}, "messages": [{"role": "user", "content": "Design a temperature sensor board"}]})
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertIn("event: complete", response.text)
                    self.assertIn("How should this sensor board be powered?", response.text)
                    self.assertGreaterEqual(len(requests), 2)
                    self.assertFalse(app.state.busy)
                    self.assertIsNone(engine.process)
                finally: await engine.stop()
        finally:
            mock.shutdown(); mock.server_close(); thread.join(timeout=5)


if __name__ == "__main__": unittest.main()
