"""Authenticated proxy around the unchanged supervisor, with process isolation."""
import asyncio
import csv
import hmac
import json
import os
import signal
import socket
import sys
import tempfile
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse


COLUMNS = ["reference", "subsystem", "category", "mfr_part", "lcsc", "package", "build_quantity"]


def localize_payload(payload, directory):
    project = payload.get("project")
    bom = project.get("bom") if isinstance(project, dict) else None
    rows = bom.get("rows") if isinstance(bom, dict) else None
    if not rows: return payload
    descriptor, name = tempfile.mkstemp(suffix=".csv", dir=directory)
    with os.fdopen(descriptor, "w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=COLUMNS, extrasaction="ignore")
        writer.writeheader(); writer.writerows(rows)
    return {**payload, "project": {**project, "bom_csv_path": name}}


class EngineProcess:
    def __init__(self, root, state, token):
        self.root, self.state, self.token = Path(root), Path(state), token
        self.process = None
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0)); self.port = probe.getsockname()[1]
        self.origin = f"http://127.0.0.1:{self.port}"

    async def start(self):
        environment = {**os.environ, "NODE_ENV": "production", "SUPERVISOR_HOST": "127.0.0.1",
                       "PORT": str(self.port), "SUPERVISOR_AGENT_TOKEN": self.token,
                       "BOARD_SANDBOX_REQUIRED": "true", "DUNKAI_EMBEDDING_DEVICE": "cpu",
                       "DESIGNER_OUTPUT_ROOT": str(self.state / "boards"),
                       "DUNKAI_CACHE_DIR": str(self.state / "cache"), "HF_HOME": str(self.state / "hf"),
                       "DUNKAI_DESIGNER_PATH": str(self.root / "dunkai-designer"),
                       "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1", "TOKENIZERS_PARALLELISM": "false"}
        # The child never needs deployment tokens or access to host control APIs.
        for key in ("HF_TOKEN_WRITE", "RENDER_API_KEY", "VERCEL_TOKEN", "SUPERVISOR_HF_TOKEN"):
            environment.pop(key, None)
        self.process = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "agents.supervisor.server", cwd=self.root / "ai_engine",
            env=environment, start_new_session=True,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        async with httpx.AsyncClient(timeout=3) as client:
            for _ in range(120):
                if self.process.returncode is not None: raise RuntimeError("The original engine failed during startup")
                try:
                    if (await client.get(self.origin + "/health")).is_success: return
                except httpx.HTTPError: pass
                await asyncio.sleep(1)
        raise RuntimeError("The original engine startup timed out")

    async def stop(self):
        process, self.process = self.process, None
        if not process: return
        try: os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        try: await asyncio.wait_for(process.wait(), 3)
        except asyncio.TimeoutError: pass
        # Kill the entire group, including designer processes orphaned by Python.
        try: os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        await process.wait()


def create_app(engine, token, *, pcb_ready=False, pcb_reason="PCB runtime not validated"):
    app = FastAPI(title="DunkAI Space", docs_url=None, redoc_url=None)
    app.state.busy = False
    engine.state.joinpath("boards").mkdir(parents=True, exist_ok=True)

    def authenticate(request):
        presented = request.headers.get("x-supervisor-token")
        if presented is None: presented = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        if not token or not hmac.compare_digest(presented.encode(), token.encode()):
            raise HTTPException(401, "Invalid supervisor token")

    @app.get("/health")
    async def health():
        return {"status": "ok" if token else "configuration_required", "engine": "original_python",
                "busy": app.state.busy, "pcb_ready": pcb_ready, "pcb_reason": pcb_reason,
                "configured": bool(token), "complete_pcb_run_validated": False}

    @app.get("/api/v1/supervisor/capabilities")
    async def capabilities(request: Request):
        authenticate(request)
        return {"data": {"default_board_provider": "groq",
                         "platform_keys": {"groq": bool(os.environ.get("GROQ_API_KEY"))},
                         "board_providers": {"groq": pcb_ready, "gemini": pcb_ready, "openai": pcb_ready,
                                             "anthropic": pcb_ready, "ollama": False, "claude-code": False},
                         "pcb_unavailable_reason": None if pcb_ready else pcb_reason}}

    @app.get("/api/v1/supervisor/artifacts/{artifact_path:path}")
    async def artifact(artifact_path: str, request: Request):
        authenticate(request)
        root = (engine.state / "boards").resolve()
        target = (root / artifact_path).resolve()
        if root not in target.parents or not target.is_file(): raise HTTPException(404, "Artifact not found")
        return FileResponse(target, headers={"Cache-Control": "private, no-store"})

    @app.post("/api/v1/supervisor")
    @app.post("/api/v1/supervisor/stream")
    @app.post("/api/v1/supervisor/code-chat")
    async def execute(request: Request):
        authenticate(request)
        if int(request.headers.get("content-length", "0")) > 2 * 1024 * 1024:
            raise HTTPException(413, "Design request is too large")
        raw = await request.body()
        if len(raw) > 2 * 1024 * 1024: raise HTTPException(413, "Design request is too large")
        try: payload = json.loads(raw)
        except ValueError: raise HTTPException(400, "Invalid design request")
        if not isinstance(payload, dict): raise HTTPException(400, "Invalid design request")
        if payload.get("action") == "generate_board" and not pcb_ready: raise HTTPException(503, pcb_reason)
        if app.state.busy: raise HTTPException(429, "Another design is running. Try again when it finishes.", headers={"Retry-After": "10"})
        app.state.busy = True
        temporary = tempfile.TemporaryDirectory(dir=engine.state)
        client = httpx.AsyncClient(timeout=httpx.Timeout(1800, connect=10), trust_env=False)
        response = None
        async def cleanup():
            if response: await response.aclose()
            await client.aclose()
            await engine.stop()
            temporary.cleanup(); app.state.busy = False
        try:
            await engine.start()
            payload = localize_payload(payload, temporary.name)
            upstream = client.build_request("POST", engine.origin + request.url.path,
                                            headers={"authorization": "Bearer " + token}, json=payload)
            response = await client.send(upstream, stream=True)
            if request.url.path.endswith("/stream") and response.is_success:
                async def events():
                    try:
                        async for chunk in response.aiter_raw(): yield chunk
                    finally: await asyncio.shield(cleanup())
                return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
            body = await response.aread()
            status = response.status_code
            await cleanup()
            from fastapi.responses import Response
            return Response(body, status_code=status, media_type="application/json")
        except BaseException as error:
            await asyncio.shield(cleanup())
            if isinstance(error, asyncio.CancelledError): raise
            raise HTTPException(503, "The original engine could not complete this request") from None

    return app
