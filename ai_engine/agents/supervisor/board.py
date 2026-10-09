"""Board generation node — drives dunkai-designer over a pcb_ir handoff.

Why this lives in the supervisor rather than in the Node backend
---------------------------------------------------------------
The backend README states one hard rule: "The Node.js backend has access to the
Supervisor Agent only." dunkai-designer is a separate Node/tscircuit project, so
calling it from `backend/` would both break that boundary and invent a SECOND
streaming mechanism alongside the SSE -> Socket.io relay that already works.

Routing it through here means "Generate PCB" is just another supervisor action:
`ai.controller.js` -> `callSupervisorStream` -> this generator -> `ai:progress`.
No new plumbing in Node, none in the frontend, and per-stage progress arrives on
the channel the workspace already listens to.

The designer speaks NDJSON on stdout (one event per line) precisely so it can be
relayed line by line without buffering the whole run.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Generator

try:
    from ..credentials import subprocess_env
    from .state import CircuitState
except ImportError:
    from credentials import subprocess_env
    from state import CircuitState

REPO_ROOT = Path(__file__).resolve().parents[3]


def _designer_root() -> Path:
    """Where dunkai-designer lives: DUNKAI_DESIGNER_PATH, else inside this repo.

    It used to be a sibling repo and this defaulted to ``../dunkai-designer``.
    It now ships in this repo at ``dunkai-designer/``, so the old default pointed
    at a directory that does not exist and every board failed preflight unless
    the override was set. The sibling location is still honoured for checkouts
    that keep it there.
    """
    override = os.getenv("DUNKAI_DESIGNER_PATH")
    if override:
        return Path(override).expanduser().resolve()
    in_repo = REPO_ROOT / "dunkai-designer"
    if in_repo.exists():
        return in_repo.resolve()
    return (REPO_ROOT.parent / "dunkai-designer").resolve()


def _output_root() -> Path:
    """
    Where generated boards land.

    Defaults under the backend's own upload directory, which `app.js` already
    serves statically at /uploads. Artifacts are far too large to travel in a
    Socket.io payload -- the Phase 1 board was 678 KB of schematic SVG, 867 KB of
    PCB SVG and 2.94 MB of GLB against an `express.json` limit of 2 MB -- so the
    pipeline returns URLs and the browser fetches the files.
    """
    override = os.getenv("DESIGNER_OUTPUT_ROOT")
    if override:
        return Path(override).expanduser().resolve()
    return (REPO_ROOT / "backend" / os.getenv("UPLOAD_DIR", "uploads") / "boards").resolve()


def _pcb_ir_from_state(state: CircuitState) -> dict[str, Any] | None:
    pcb_ir = state.get("pcb_ir")
    if isinstance(pcb_ir, dict) and pcb_ir.get("components"):
        return pcb_ir
    return None


def _slug(text: str) -> str:
    keep = [c if (c.isalnum() or c in "-_") else "-" for c in str(text).strip().lower()]
    return "".join(keep).strip("-") or "design"


def _designer_command(designer: Path, out_dir: Path, provider: str, model: str | None) -> list[str]:
    cmd = [
        shutil.which("node") or "node",
        str(designer / "src" / "cli.mjs"),
        "--ir",
        "-",
        "--out",
        str(out_dir),
        "--provider",
        provider,
    ]
    if model:
        cmd += ["--model", model]
    return cmd


def _preflight(designer: Path) -> str | None:
    """Return a human-readable reason the designer cannot run, or None."""
    if not designer.exists():
        return f"dunkai-designer not found at {designer} (set DUNKAI_DESIGNER_PATH)"
    if not (designer / "src" / "cli.mjs").exists():
        return f"dunkai-designer at {designer} has no src/cli.mjs"
    if not (designer / "node_modules").exists():
        return f"dunkai-designer at {designer} has no node_modules — run npm install there"
    if shutil.which("node") is None:
        return "node is not on PATH"
    if os.getenv("BOARD_SANDBOX_REQUIRED") == "true" and shutil.which("bwrap") is None:
        return "board sandbox is required but bubblewrap is unavailable"
    return None


def stream_board(state: CircuitState, job_id: str) -> Generator[dict[str, Any], None, None]:
    """
    Yield progress dicts as dunkai-designer runs.

    Each yielded dict is handed straight to the SSE layer. Designer stage events
    are passed through with their own shape so the UI can show real per-stage
    progress rather than a spinner.
    """
    pcb_ir = _pcb_ir_from_state(state)
    if pcb_ir is None:
        yield {"kind": "error", "error": "Board generation needs a pcb_ir with components."}
        return
    # Recheck saved BOMs as well: older runs labelled unrelated substitutes OK.
    from component_agent.suitability import mismatch
    from external_devices import coverage_issues
    bom = state.get("bom") or {}
    coverage = coverage_issues(state.get("architecture") or {}, bom.get("rows", []))
    if coverage:
        yield {"kind": "error", "error": "Required devices remain in the BOM, but the board handoff needs repair: " + "; ".join(coverage)}
        return
    problems = []
    for row in bom.get("rows", []):
        if row.get("external") or row.get("board_profile"): continue
        if row.get("description"):
            reason = mismatch(row, {"subsystem": row.get("subsystem", "")})
            if reason: problems.append(f"{row.get('reference')}: {row.get('subsystem')} ({row.get('mfr_part')})")
    if problems:
        yield {"kind": "error", "error": "The BOM contains parts that do not establish the required functions: " + "; ".join(problems[:6]) + ". Regenerate the design with suitable components or external-device interfaces."}
        return

    designer = _designer_root()
    problem = _preflight(designer)
    if problem:
        yield {"kind": "error", "error": problem}
        return

    design_name = str(pcb_ir.get("design_name") or state.get("design_name") or "design")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    out_dir = _output_root() / f"{_slug(design_name)}-{stamp}-{job_id[:8]}"
    out_dir.mkdir(parents=True, exist_ok=True)

    # Auto keeps the chat's exact model for pin mapping, footprints and repairs.
    from agents.credentials import llm_model
    provider = state.get("designer_provider")
    if not provider or provider == "auto":
        model = state.get("designer_model") or state.get("llm_model") or llm_model()
        provider = "openai" if model in ("gpt-4.1", "gpt-4.1-mini") else "groq"
    else:
        model = state.get("designer_model") or os.getenv("DESIGNER_MODEL") or None
    cmd = _designer_command(designer, out_dir, provider, model)

    yield {
        "kind": "progress",
        "node": "board",
        "label": "Starting board generation",
        "detail": f"provider {provider}",
    }

    process = subprocess.Popen(
        cmd,
        cwd=str(designer),
        # The designer reads provider keys from its environment. A BYOK user's
        # key goes into this child's copy only, never into ours, where every
        # concurrent run would see it.
        env=subprocess_env(),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    timeout_seconds = max(60, int(os.getenv("BOARD_JOB_TIMEOUT_SECONDS", "900")))
    timer = threading.Timer(timeout_seconds, process.kill)
    timer.daemon = True
    timer.start()

    # Drain stderr on a thread while we read stdout.
    #
    # The designer writes a running commentary to stderr (tsci output, gate
    # notes, per-component detail). If nobody reads that pipe until the process
    # exits, it fills at the OS buffer limit (~64KB) and the child BLOCKS
    # writing to it — while we sit blocked reading stdout it will now never
    # write to. That is a deadlock that gets more likely the bigger the design
    # is, which is exactly backwards.
    stderr_chunks: list[str] = []

    def _drain_stderr() -> None:
        try:
            for line in process.stderr:
                stderr_chunks.append(line)
        except Exception:  # pragma: no cover - pipe torn down with the process
            pass

    stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
    stderr_thread.start()

    try:
        process.stdin.write(json.dumps(pcb_ir))
        process.stdin.close()
    except Exception as exc:  # pragma: no cover - only on a dead child
        process.kill()
        yield {"kind": "error", "error": f"could not send pcb_ir to designer: {exc}"}
        return

    final: dict[str, Any] | None = None
    error: str | None = None

    for line in process.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            # stdout is contractually NDJSON; anything else is a bug in the
            # designer, and swallowing it silently would hide that.
            print(f"[board] non-JSON on designer stdout: {line[:200]}", file=sys.stderr)
            continue

        kind = event.get("ev")
        if kind == "stage":
            yield {
                "kind": "progress",
                "node": "board",
                "stage": event.get("stage"),
                "label": event.get("label"),
                "status": event.get("status"),
                "detail": event.get("detail"),
            }
        elif kind == "item":
            yield {
                "kind": "progress",
                "node": "board",
                "stage": event.get("stage"),
                "label": f"{event.get('ref_id')}: {event.get('status')}",
                "detail": event.get("detail"),
                "ref_id": event.get("ref_id"),
                "tier": event.get("tier"),
                "status": event.get("status"),
            }
        elif kind == "result":
            final = event
        elif kind == "usage":
            try:
                from ..usage_meter import record_external_usage
            except ImportError:
                from usage_meter import record_external_usage
            record_external_usage(event.get("model"), event.get("tokens"))
        elif kind == "error":
            error = event.get("message")

    process.wait()
    timer.cancel()
    stderr_thread.join(timeout=5)
    stderr_tail = "".join(stderr_chunks)[-2000:]

    if final is None:
        yield {
            "kind": "error",
            "error": error or f"designer exited {process.returncode} without a result",
            "detail": stderr_tail,
        }
        return

    yield {"kind": "complete", "board": _to_artifact(final, out_dir)}


def _to_artifact(final: dict[str, Any], out_dir: Path) -> dict[str, Any]:
    """
    Turn the designer's result event into the shape the frontend consumes.

    Paths are rewritten to /uploads URLs when the output sits under the backend's
    upload directory, and left as filesystem paths otherwise, so a run with a
    custom DESIGNER_OUTPUT_ROOT still reports something truthful instead of a URL
    that 404s.
    """
    files = final.get("files") or {}
    upload_root = _output_root().parent  # .../uploads

    def to_url(rel: str) -> str:
        absolute = (out_dir / rel).resolve()
        try:
            relative = absolute.relative_to(upload_root)
        except ValueError:
            return str(absolute)
        return "/uploads/" + str(relative).replace(os.sep, "/")

    return {
        "design_name": final.get("designName"),
        "out_dir": str(out_dir),
        "urls": {key: to_url(rel) for key, rel in files.items()},
        "sizes": final.get("sizes") or {},
        "stats": final.get("stats") or {},
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def board_node(state: CircuitState) -> dict[str, Any]:
    """Non-streaming variant, for the plain (non-SSE) supervisor action."""
    job_id = str(uuid.uuid4())
    board: dict[str, Any] | None = None
    errors: list[str] = []

    for event in stream_board(state, job_id):
        if event.get("kind") == "complete":
            board = event.get("board")
        elif event.get("kind") == "error":
            errors.append(str(event.get("error")))

    if board is None:
        return {
            "current_node": "board",
            "errors": errors or ["Board generation produced no result."],
            "workflow_status": "failed",
        }

    return {"current_node": "board", "board": board}
