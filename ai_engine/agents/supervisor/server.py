"""FastAPI Supervisor HTTP server for the dunkai LangGraph pipeline.

The Node.js backend talks only to this endpoint. Individual agents remain
internal and are invoked through graph nodes or direct node wrappers.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import shutil
import threading
import uuid
from queue import Empty, Queue
from typing import Any

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from langchain_groq import ChatGroq
from langchain_core.messages import HumanMessage, SystemMessage, AIMessage
try:
    from ..usage_meter import USAGE_CALLBACK, capture_usage
except ImportError:
    from usage_meter import USAGE_CALLBACK, capture_usage

try:
    from ..credentials import api_key, groq_api_key, use_credentials
    from .board import _output_root, board_node, stream_board
    from .graph import compile_graph, run_workflow, stream_workflow
    from .nodes import (
        architecture_node,
        code_generation_node,
        component_node,
        documentation_node,
        eda_enrichment_node,
        pcb_node,
        requirements_node,
        safety_node,
        validation_node,
    )
    from .state import CircuitState, _merge_errors
except ImportError:
    from credentials import api_key, groq_api_key, use_credentials
    from board import _output_root, board_node, stream_board
    from graph import compile_graph, run_workflow, stream_workflow
    from nodes import (
        architecture_node,
        code_generation_node,
        component_node,
        documentation_node,
        eda_enrichment_node,
        pcb_node,
        requirements_node,
        safety_node,
        validation_node,
    )
    from state import CircuitState, _merge_errors

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="dunkai Supervisor Agent", version="1.0.0")

# No CORS middleware: the only caller is the Node backend, server-to-server.
# A browser has no business reaching this service, and the old wildcard policy
# (allow_origins=["*"] with credentials) invited exactly that.

_SUPERVISOR_TOKEN = os.getenv("SUPERVISOR_AGENT_TOKEN", "")


def require_backend(authorization: str | None = Header(default=None), x_supervisor_token: str | None = Header(default=None)) -> None:
    """Reject callers that are not the Node backend.

    The backend has always sent ``Authorization: Bearer $SUPERVISOR_AGENT_TOKEN``,
    but nothing here checked it, so anyone who could reach this port could run
    the pipeline on the operator's Groq key -- and, with BYOK, these requests
    now carry users' keys too. When the token is unset (local development) the
    check is skipped, and a warning at startup says so.
    """
    if not _SUPERVISOR_TOKEN:
        return
    # A private Hugging Face Space consumes Authorization at its edge. Node
    # then carries our separate application credential in this header.
    presented = x_supervisor_token if x_supervisor_token is not None else (authorization or "").removeprefix("Bearer ").strip()
    if not hmac.compare_digest(presented.encode(), _SUPERVISOR_TOKEN.encode()):
        raise HTTPException(status_code=401, detail="Invalid supervisor token")


@app.on_event("startup")
def startup_event():
    if os.getenv("NODE_ENV") == "production" and not _SUPERVISOR_TOKEN:
        raise RuntimeError("SUPERVISOR_AGENT_TOKEN is required in production")
    if not _SUPERVISOR_TOKEN:
        logger.warning("SUPERVISOR_AGENT_TOKEN is not set: the supervisor accepts unauthenticated requests. "
                       "Set it (and the same value on the backend) before exposing this service.")
    logger.info("Warming up Supervisor pipeline and compiling graph...")
    compile_graph()
    logger.info("Supervisor pipeline ready.")


SINGLE_NODE_ACTIONS = {
    "generate_requirements": requirements_node,
    "generate_architecture": architecture_node,
    "generate_components": component_node,
    "generate_eda": eda_enrichment_node,
    "generate_pcb": pcb_node,
    "generate_validation": validation_node,
    "generate_documentation": documentation_node,
    "generate_code": code_generation_node,
    # Runs dunkai-designer over an existing pcb_ir. Deliberately NOT a node in
    # the linear graph: the board is built when the user asks for it, not on
    # every chat turn, and it costs minutes and a provider call.
    "generate_board": board_node,
}


class SupervisorRequest(BaseModel):
    action: str = "run_workflow"
    project: dict[str, Any] | str | None = None
    messages: list[dict[str, Any]] = Field(default_factory=list)
    files: list[Any] = Field(default_factory=list)
    jobId: str | None = None
    agentType: str | None = None
    # Board-generation provider/model, chosen per request. Validated against the
    # designer's registry downstream; an unknown name fails the run with the
    # registry's own "available: ..." message rather than being ignored.
    provider: str | None = None
    model: str | None = None
    # BYOK: the user's own provider keys, {"groq": "...", "gemini": "..."}.
    # Never copied into the graph state (which is serialised back to the
    # browser) -- only activated for the request via use_credentials.
    credentials: dict[str, str] | None = Field(default=None, repr=False)


def _latest_user_message(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        role = message.get("role") or message.get("type")
        content = message.get("content")
        if role in {"user", "human"} and isinstance(content, str) and content.strip():
            return content.strip()
    return ""


def _extract_requirements(payload: SupervisorRequest) -> dict[str, Any] | None:
    project = payload.project if isinstance(payload.project, dict) else {}
    for key in ("requirements", "requirement", "hardware_requirements"):
        value = project.get(key)
        if isinstance(value, dict) and value:
            return value

    for message in reversed(payload.messages):
        content = message.get("content")
        if not isinstance(content, str):
            continue
        text = content.strip()
        if not text.startswith("{"):
            continue
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and (
            "functional_requirements" in parsed
            or "project_name" in parsed
            or "objective" in parsed
        ):
            return parsed
    return None


def _extract_architecture(payload: SupervisorRequest) -> dict[str, Any] | None:
    project = payload.project if isinstance(payload.project, dict) else {}
    for key in ("architecture", "architecture_result"):
        value = project.get(key)
        if isinstance(value, dict) and value:
            return value
    return None


def _build_initial_state(payload: SupervisorRequest) -> CircuitState:
    project = payload.project if isinstance(payload.project, dict) else {}
    state: CircuitState = {
        "messages": [],
        "errors": [],
        "build_quantity": int(project.get("build_quantity") or project.get("buildQuantity") or 1),
    }

    design_name = project.get("name") or project.get("project_name")
    if isinstance(design_name, str) and design_name.strip():
        state["design_name"] = design_name.strip()

    requirements = _extract_requirements(payload)
    if requirements:
        state["requirements"] = requirements

    architecture = _extract_architecture(payload)
    if architecture:
        state["architecture"] = architecture

    for key in ("bom", "eda_data", "pcb_ir", "validation", "handoff_validation", "documentation", "code_generation", "board"):
        value = project.get(key)
        if isinstance(value, dict) and value:
            state[key] = value  # type: ignore[literal-required]

    if isinstance(project.get("bom_csv_path"), str):
        state["bom_csv_path"] = project["bom_csv_path"]

    if isinstance(payload.provider, str) and payload.provider.strip():
        state["designer_provider"] = payload.provider.strip()
    if isinstance(payload.model, str) and payload.model.strip():
        state["designer_model"] = payload.model.strip()
        state["llm_model"] = payload.model.strip()

    user_input = _latest_user_message(payload.messages)
    if user_input:
        state["user_input"] = user_input

    history = payload.messages[:-1] if len(payload.messages) > 1 else []
    if not history:
        history = project.get("interview_history") or project.get("interviewHistory") or []
    if history:
        state["interview_history"] = history

    return state


def _serialize_state(state: CircuitState) -> dict[str, Any]:
    messages = []
    for message in state.get("messages") or []:
        if hasattr(message, "content"):
            messages.append({"role": "assistant", "content": str(message.content)})
        elif isinstance(message, dict):
            messages.append(message)

    return {
        "requirements": state.get("requirements"),
        "architecture": state.get("architecture"),
        "bom": state.get("bom"),
        "eda_data": state.get("eda_data"),
        "pcb_ir": state.get("pcb_ir"),
        "validation": state.get("validation"),
        # Schema 2.0 handoff result. Distinct key from "validation" on purpose:
        # well_formed != passed, and neither means "buildable" -- see nodes.py.
        "handoff_validation": state.get("handoff_validation"),
        "documentation": state.get("documentation"),
        "code_generation": state.get("code_generation"),
        # Generated board artifacts, when "Generate PCB" has been run.
        "board": state.get("board"),
        "messages": messages,
        "errors": state.get("errors") or [],
        "workflow_status": state.get("workflow_status"),
        "interview_status": state.get("interview_status"),
        "interview_question": state.get("interview_question"),
        "interview_options": state.get("interview_options"),
        "interview_selection_mode": state.get("interview_selection_mode"),
        "current_node": state.get("current_node"),
        "bom_csv_path": state.get("bom_csv_path"),
        # The requester sees the verdict only. The full record (category,
        # reasoning, conversation) travels as `safety_audit`, which the Node
        # backend removes before anything reaches the browser, and stores.
        "safety": {"verdict": (state.get("safety") or {}).get("verdict")} if state.get("safety") else None,
        "safety_audit": state.get("safety"),
    }


def _action_for_agent_type(agent_type: str | None) -> str | None:
    mapping = {
        "requirement": "generate_requirements",
        "architecture": "generate_architecture",
        "component": "generate_components",
        "pcb": "generate_pcb",
        "validation": "generate_validation",
        "documentation": "generate_documentation",
    }
    if not agent_type:
        return None
    return mapping.get(agent_type)


# Ordered most-downstream-first: a message mentioning several stage-ish
# words routes to the most specific (and most expensive to skip) one.
#
# These are short *stems*, not full words, on purpose: chat input is typed
# fast and typo'd often ("architechture" for "architecture" is the message
# that motivated this whole mechanism -- it does not contain "architecture"
# as a substring, but does contain "archi"). A stem long enough to be
# specific to one domain word is more typo-tolerant than the full spelling.
_REVISION_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("generate_code", ("firmware", "the code", "generate code", "write the code", "driver code", "code stub", "code generation")),
    ("generate_documentation", ("docum", "readme", "doc package", "docs page")),
    ("generate_validation", ("validat", "drc", "design rule check")),
    ("generate_pcb", ("pcb", "board layout", "routing", "trace width", "footprint placement")),
    ("generate_eda", ("eda enrichment", "footprint data", "symbol data", "eda dataset")),
    ("generate_components", ("bom", "compon", "parts list", "supplier", "cost breakdown", "swap the part", "replace the part")),
    ("generate_architecture", ("archi", "block diagram", "subsystem", "topology", "the diagram")),
]

# What must already be on the state for that single-node action to make
# sense as a revision. If it's missing, there's nothing to revise yet, so
# the request falls through to the full pipeline instead.
_SINGLE_NODE_PREREQ: dict[str, tuple[str, ...]] = {
    "generate_code": ("validation", "handoff_validation"),
    "generate_documentation": ("validation", "handoff_validation"),
    "generate_validation": ("pcb_ir",),
    "generate_pcb": ("eda_data",),
    "generate_eda": ("bom",),
    "generate_components": ("architecture",),
    "generate_architecture": ("requirements",),
}

_SINGLE_NODE_TO_GRAPH_NAME: dict[str, str] = {
    "generate_requirements": "requirements",
    "generate_architecture": "architecture",
    "generate_components": "component",
    "generate_eda": "eda_enrichment",
    "generate_pcb": "pcb",
    "generate_validation": "validation",
    "generate_documentation": "documentation",
    "generate_code": "code_generation",
}


def _infer_single_node_action(user_input: str, state: CircuitState) -> str | None:
    """Best-effort routing so a targeted revision ("make the architecture
    more detailed") re-runs only the one relevant pipeline stage instead of
    the full linear graph cascading all the way through a fresh BOM, PCB,
    validation, documentation and code build every single chat turn.

    Deliberately conservative: only fires once a design already exists
    (requirements on the state) and only for a stage whose prerequisite is
    also already on the state. This is a keyword heuristic, not real intent
    understanding -- a message that matches nothing, or matches a stage
    that isn't buildable yet, falls through to the full workflow, which is
    always correct, just not always the cheapest.
    """
    if not state.get("requirements"):
        return None
    text = (user_input or "").lower().strip()
    if not text:
        return None
    for action, keywords in _REVISION_KEYWORDS:
        if any(kw in text for kw in keywords):
            prereqs = _SINGLE_NODE_PREREQ.get(action, ())
            if prereqs and not any(state.get(key) for key in prereqs):
                return None
            return action
    return None


def _run_single_node(action: str, state: CircuitState) -> CircuitState:
    node_fn = SINGLE_NODE_ACTIONS.get(action)
    if node_fn is None:
        raise HTTPException(status_code=400, detail=f"Unknown action: {action}")
    return _run_single_node_fn(node_fn, state)


def _run_single_node_fn(node_fn, state: CircuitState) -> CircuitState:
    update = node_fn(state)
    merged: CircuitState = dict(state)
    for key, value in update.items():
        if key == "messages":
            merged["messages"] = list(merged.get("messages") or []) + list(value or [])
        elif key == "errors":
            merged["errors"] = _merge_errors(merged.get("errors"), value)
        else:
            merged[key] = value  # type: ignore[literal-required]
    return merged


def _handle_chat(payload: SupervisorRequest) -> dict[str, Any]:
    action = _action_for_agent_type(payload.agentType) or "generate_requirements"
    state = _build_initial_state(payload)

    # The same gate the graph applies: this path runs an agent directly.
    checked = _run_single_node_fn(safety_node, state)
    if checked.get("workflow_status") == "blocked":
        messages = checked.get("messages") or []
        reply = str(getattr(messages[-1], "content", "")) if messages else "This request can't be processed."
        return {"reply": reply, "data": _serialize_state(checked)}

    final_state = _run_single_node(action, checked)
    data = _serialize_state(final_state)

    if final_state.get("interview_status") == "question":
        reply = final_state.get("interview_question") or "Please provide more detail."
    elif final_state.get("errors"):
        reply = "; ".join(final_state["errors"])
    else:
        reply = "Agent step completed."

    return {"reply": reply, "data": data}


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


#: Board providers that bill an API key, and the credential each one needs.
_KEYED_BOARD_PROVIDERS = ("groq", "gemini", "anthropic", "ollama")


@app.get("/api/v1/supervisor/capabilities", dependencies=[Depends(require_backend)])
def capabilities() -> dict[str, Any]:
    """What this deployment can run on the operator's own setup.

    The backend combines this with each user's BYOK keys to decide which board
    providers to offer. ``claude-code`` needs the ``claude`` CLI on this host,
    which a typical container does not have; the keyed providers need a key
    here unless the user brings their own. Ollama can also run keyless against
    a daemon, so a configured base URL counts.
    """
    board = {"claude-code": bool(os.getenv("CLAUDE_CLI") or shutil.which("claude"))}
    for provider in _KEYED_BOARD_PROVIDERS:
        board[provider] = bool(api_key(provider))
    if os.getenv("OLLAMA_BASE_URL"):
        board["ollama"] = True
    return {
        "data": {
            "platform_keys": {name: bool(api_key(name)) for name in _KEYED_BOARD_PROVIDERS},
            "board_providers": board,
            "default_board_provider": os.getenv("DESIGNER_PROVIDER") or "groq",
        }
    }


@app.get("/api/v1/supervisor/artifacts/{artifact_path:path}", dependencies=[Depends(require_backend)])
def board_artifact(artifact_path: str):
    """Serve a generated board file when the backend cannot see this disk.

    Co-located deployments write boards straight into the backend's upload
    directory and never call this. When the AI engine runs on its own host,
    the backend proxies ``/uploads/boards/*`` here instead.
    """
    root = _output_root()
    target = (root / artifact_path).resolve()
    if root not in target.parents or not target.is_file():
        raise HTTPException(status_code=404, detail="Artifact not found")
    return FileResponse(target)


@app.post("/api/v1/supervisor", dependencies=[Depends(require_backend)])
def supervisor_endpoint(payload: SupervisorRequest) -> dict[str, Any]:
    with use_credentials(payload.credentials), capture_usage() as usage:
        result = _supervisor_dispatch(payload)
        result["providerUsage"] = usage
        return result


def _supervisor_dispatch(payload: SupervisorRequest) -> dict[str, Any]:
    action = payload.action or "run_workflow"
    job_id = payload.jobId or str(uuid.uuid4())

    logger.info("Supervisor action=%s jobId=%s", action, job_id)

    if action == "chat":
        return {"data": _handle_chat(payload), "jobId": job_id}

    if action == "run_workflow":
        initial_state = _build_initial_state(payload)
        inferred = _infer_single_node_action(initial_state.get("user_input") or "", initial_state)
        if inferred:
            logger.info("Routing run_workflow -> %s based on message intent (jobId=%s)", inferred, job_id)
            checked = _run_single_node_fn(safety_node, initial_state)
            final_state = checked if checked.get("workflow_status") == "blocked" else _run_single_node(inferred, checked)
            return {"data": _serialize_state(final_state), "jobId": job_id, "status": "completed"}
        final_state = run_workflow(initial_state)
        return {"data": _serialize_state(final_state), "jobId": job_id, "status": "completed"}

    if action == "generate_eda":
        initial_state = _build_initial_state(payload)
        if not initial_state.get("bom"):
            if not initial_state.get("architecture"):
                initial_state = _run_single_node("generate_architecture", initial_state)
            initial_state = _run_single_node("generate_components", initial_state)
        final_state = _run_single_node("generate_eda", initial_state)
        return {"data": _serialize_state(final_state), "jobId": job_id, "status": "completed"}

    if action in SINGLE_NODE_ACTIONS:
        initial_state = _build_initial_state(payload)
        final_state = _run_single_node(action, initial_state)
        return {"data": _serialize_state(final_state), "jobId": job_id, "status": "completed"}

    raise HTTPException(status_code=400, detail=f"Unsupported action: {action}")


# ---------------------------------------------------------------------------
# SSE streaming endpoint (new — does not alter the endpoint above)
# ---------------------------------------------------------------------------

# Human-readable labels shown in progress events.
_NODE_LABELS: dict[str, str] = {
    "supervisor": "Starting workflow",
    "safety": "Checking the request",
    "requirements": "Analysing requirements",
    "architecture": "Generating architecture",
    "component": "Selecting components & building BOM",
    "eda_enrichment": "Enriching EDA data",
    "pcb": "Generating PCB layout",
    "validation": "Running validation checks",
    "documentation": "Compiling documentation",
    "code_generation": "Generating code suggestions",
}


def _sse_event(data: dict[str, Any], event: str = "progress") -> str:
    """Format a single SSE event line.  Always ends with a double newline."""
    payload = json.dumps(data, default=str)
    return f"event: {event}\ndata: {payload}\n\n"


def _stream_board_events(state: CircuitState, job_id: str):
    """Relay dunkai-designer's stage events as SSE, then one final state."""
    board: dict[str, Any] | None = None
    errors: list[str] = []

    try:
        for event in stream_board(state, job_id):
            kind = event.get("kind")
            if kind == "progress":
                yield _sse_event(
                    {
                        "jobId": job_id,
                        "node": "board",
                        "stage": event.get("stage"),
                        "label": event.get("label"),
                        "detail": event.get("detail"),
                        "ref_id": event.get("ref_id"),
                        "tier": event.get("tier"),
                        "status": event.get("status", "running"),
                        "errors": [],
                    },
                    event="progress",
                )
            elif kind == "complete":
                board = event.get("board")
            elif kind == "error":
                errors.append(str(event.get("error")))
    except Exception as exc:
        logger.exception("Board generation failed")
        yield _sse_event({"jobId": job_id, "error": str(exc), "node": "board"}, event="error")
        return

    if board is None:
        yield _sse_event(
            {"jobId": job_id, "error": "; ".join(errors) or "Board generation failed.", "node": "board"},
            event="error",
        )
        return

    final_state: CircuitState = dict(state)
    final_state["board"] = board
    final_state["current_node"] = "board"
    final_state["workflow_status"] = "completed"

    yield _sse_event(
        {"jobId": job_id, "data": _serialize_state(final_state), "status": "completed"},
        event="complete",
    )


def _stream_generator(payload: SupervisorRequest):
    """Yield SSE text chunks as the LangGraph pipeline progresses.

    Each node completion produces an ``event: progress`` chunk.
    If an agent raises, we yield ``event: error`` so the consumer knows
    the stream failed *after* the HTTP 200 was already sent.
    On success the final chunk is ``event: complete`` with the full state.

    The user's keys are active for the whole generator. It is drained on the
    keepalive pump thread, which calls ``next()`` from one context throughout,
    so the value set here is the one every node of this run sees.
    """
    with use_credentials(payload.credentials), capture_usage() as usage:
        for chunk in _stream_events(payload):
            if chunk.startswith(("event: complete\n", "event: error\n")):
                event, data_line, *_ = chunk.split("\n")
                data = json.loads(data_line.removeprefix("data: "))
                data["providerUsage"] = list(usage)
                chunk = _sse_event(data, event.removeprefix("event: "))
            yield chunk


def _interface_revision_instruction(state: CircuitState) -> str | None:
    """A revision instruction built from the board stage's open connections.

    dunkai-designer checks every part against its real pinout and reports the
    connections it had to leave open, with what each part supports instead
    (board.stats.mismatches). The architecture agent already edits an existing
    graph from an instruction; this gives it a precise one, naming each part by
    its subsystem so the agent can find the right node.
    """
    board = state.get("board") or {}
    mismatches = (board.get("stats") or {}).get("mismatches") or []
    if not mismatches:
        return None

    subsystem_of = {}
    for row in (state.get("bom") or {}).get("rows") or []:
        part = row.get("mfr_part")
        if part and row.get("subsystem"):
            subsystem_of[str(part).upper()] = row["subsystem"]

    by_part: dict[str, dict[str, Any]] = {}
    for m in mismatches:
        key = m.get("ref_id") or "?"
        entry = by_part.setdefault(key, {"m": m, "interfaces": set()})
        entry["interfaces"].add(m.get("interface"))

    lines = [
        "The board stage checked every selected part against its real pinout. These",
        "connections cannot be built as designed, because the part does not have that interface:",
    ]
    for ref, entry in by_part.items():
        m = entry["m"]
        name = subsystem_of.get(str(m.get("part_number", "")).upper())
        who = f"{name} ({ref}, {m.get('part_number')})" if name else f"{ref} ({m.get('part_number')})"
        asked = ", ".join(sorted(i for i in entry["interfaces"] if i))
        lines.append(f"- {who}: connected via {asked}, but the part supports: {', '.join(m.get('supports') or ['unknown'])}.")
    lines += [
        "",
        "Revise the architecture so every connection to these subsystems uses an interface",
        "the part supports (for a segment display: GPIO, or add a driver IC; for a 1-Wire",
        "sensor: OneWire). Where the part has no usable signal interface, drop that",
        "connection. Keep every other subsystem and connection exactly as it is.",
    ]
    return "\n".join(lines)


#: The stages downstream of the architecture, re-run after an interface revision.
_REVISION_CHAIN = [
    ("architecture", architecture_node),
    ("component", component_node),
    ("eda_enrichment", eda_enrichment_node),
    ("pcb", pcb_node),
    ("validation", validation_node),
]


def _stream_interface_revision(initial_state: CircuitState, job_id: str):
    instruction = _interface_revision_instruction(initial_state)
    if not instruction:
        yield _sse_event({"jobId": job_id, "error": "No open connections to revise — the board reported none.", "node": "architecture"}, event="error")
        return

    state: CircuitState = dict(initial_state)
    state["user_input"] = instruction
    yield _sse_event({"jobId": job_id, "node": "__start__", "label": "Revising interfaces"}, event="progress")
    for node_name, node_fn in _REVISION_CHAIN:
        yield _sse_event(
            {"jobId": job_id, "node": node_name, "label": _NODE_LABELS.get(node_name, node_name), "status": "running", "errors": []},
            event="progress",
        )
        try:
            state = _run_single_node_fn(node_fn, state)
        except Exception as exc:
            logger.exception("Interface revision failed at %s", node_name)
            yield _sse_event({"jobId": job_id, "error": str(exc), "node": node_name}, event="error")
            return
        if state.get("errors"):
            break
    # The old board was built from the old wiring; it no longer describes this
    # design, and the workspace builds a new one from the fresh handoff.
    state["board"] = None
    yield _sse_event({"jobId": job_id, "data": _serialize_state(state), "status": "completed"}, event="complete")


def _stream_events(payload: SupervisorRequest):
    job_id = payload.jobId or str(uuid.uuid4())
    initial_state = _build_initial_state(payload)

    if (payload.action or "") == "revise_interfaces":
        yield from _stream_interface_revision(initial_state, job_id)
        return

    # Board generation is its own streaming shape: dunkai-designer reports six
    # named stages plus per-component resolution detail, none of which maps onto
    # a LangGraph node. It is relayed on the SAME `progress`/`complete` events so
    # nothing downstream needs a second code path.
    if (payload.action or "") == "generate_board":
        yield from _stream_board_events(initial_state, job_id)
        return

    action = payload.action or "run_workflow"
    inferred_action = False
    if action == "run_workflow":
        inferred = _infer_single_node_action(initial_state.get("user_input") or "", initial_state)
        if inferred:
            logger.info("Routing run_workflow -> %s based on message intent (jobId=%s)", inferred, job_id)
            action = inferred
            inferred_action = True

    # A targeted revision: run exactly one stage and stop, instead of the
    # full graph cascading through everything downstream of it. This is what
    # makes "make the architecture more detailed" touch only architecture
    # rather than also regenerating the BOM, PCB, docs and code.
    if action in SINGLE_NODE_ACTIONS:
        node_name = _SINGLE_NODE_TO_GRAPH_NAME.get(action, action)
        label = _NODE_LABELS.get(node_name, node_name)
        yield _sse_event({"jobId": job_id, "node": "__start__", "label": "Pipeline starting"}, event="progress")
        if inferred_action:
            try:
                initial_state = _run_single_node_fn(safety_node, initial_state)
            except Exception as exc:
                logger.exception("Safety gate failed")
                yield _sse_event({"jobId": job_id, "error": str(exc), "node": "safety"}, event="error")
                return
            if initial_state.get("workflow_status") == "blocked":
                yield _sse_event(
                    {"jobId": job_id, "data": _serialize_state(initial_state), "status": "completed"},
                    event="complete",
                )
                return
        yield _sse_event(
            {"jobId": job_id, "node": node_name, "label": label, "status": "running", "errors": []},
            event="progress",
        )
        try:
            final_state = _run_single_node(action, initial_state)
        except Exception as exc:
            logger.exception("Single-node action failed")
            yield _sse_event({"jobId": job_id, "error": str(exc), "node": node_name}, event="error")
            return
        yield _sse_event(
            {"jobId": job_id, "data": _serialize_state(final_state), "status": "completed"},
            event="complete",
        )
        return

    # Tell the client we're starting.
    yield _sse_event({"jobId": job_id, "node": "__start__", "label": "Pipeline starting"}, event="progress")

    final_state: CircuitState = dict(initial_state)

    try:
        for node_name, state_snapshot in stream_workflow(initial_state):
            final_state = state_snapshot
            label = _NODE_LABELS.get(node_name, node_name)

            yield _sse_event(
                {
                    "jobId": job_id,
                    "node": node_name,
                    "label": label,
                    "status": state_snapshot.get("workflow_status", "running"),
                    "errors": state_snapshot.get("errors") or [],
                },
                event="progress",
            )

    except Exception as exc:
        logger.exception("Streaming workflow failed at node level")
        yield _sse_event(
            {
                "jobId": job_id,
                "error": str(exc),
                "node": final_state.get("current_node", "unknown"),
            },
            event="error",
        )
        return  # Close the stream.

    # Final event carries the complete serialised state.
    yield _sse_event(
        {"jobId": job_id, "data": _serialize_state(final_state), "status": "completed"},
        event="complete",
    )


#: How long the stream may stay silent before a keepalive comment is sent.
#: Node's fetch (undici) enforces a 300s *body* timeout that is separate from
#: any AbortSignal, so this must stay comfortably under it.
_KEEPALIVE_SECONDS = 20.0

#: Pushed onto the queue by the pump thread when the source generator ends.
_STREAM_DONE = object()


def _with_keepalive(source, interval: float = _KEEPALIVE_SECONDS):
    """
    Yield from ``source``, emitting an SSE comment whenever it goes quiet.

    Why this is not optional
    ------------------------
    ``callSupervisorStream`` in the Node backend documents "No signal / no
    timeout — the stream lives as long as the pipeline runs", and sets none.
    But undici applies its own ``bodyTimeout`` (300s by default) to the
    *response body*, which no AbortController setting touches. A stage that
    reports nothing for longer than that has its stream torn down mid-run and
    the backend logs:

        [AI Stream] job <id> failed: terminated

    Observed on a real "Generate PCB" run: stage D took 5m53s of provider time
    in one silent block, the body timed out at 5m, and the client never
    received ``ai:complete`` — while the designer ran happily to completion and
    wrote a clean board to disk. The work was fine; only the reporting died,
    which is the worst version of this failure because nothing looks wrong
    server-side.

    A ``:`` line is the SSE comment form. The backend's ``parseSSEBuffer``
    drops any block carrying no ``data:`` line, so these cost one skipped block
    and never reach a socket — but they are bytes on the wire, which is what
    resets the timer.

    The source is drained on a thread because it blocks on the child process;
    a generator cannot both wait for output and notice that it has been waiting.
    """
    queue: "Queue[Any]" = Queue()

    def pump() -> None:
        try:
            for chunk in source:
                queue.put(chunk)
        except Exception as exc:  # relayed below, on the response thread
            queue.put(exc)
        finally:
            queue.put(_STREAM_DONE)

    thread = threading.Thread(target=pump, daemon=True)
    thread.start()

    while True:
        try:
            item = queue.get(timeout=interval)
        except Empty:
            yield ": keepalive\n\n"
            continue
        if item is _STREAM_DONE:
            return
        if isinstance(item, Exception):
            raise item
        yield item


@app.post("/api/v1/supervisor/stream", dependencies=[Depends(require_backend)])
def supervisor_stream_endpoint(payload: SupervisorRequest):
    """SSE streaming variant of the supervisor endpoint.

    Returns ``text/event-stream`` so the Node.js backend can read
    progress events as they arrive and relay them over Socket.io.
    """
    return StreamingResponse(
        _with_keepalive(_stream_generator(payload)),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # Disable nginx buffering if proxied.
        },
    )


class CodeChatRequest(BaseModel):
    files: list[dict]
    messages: list[dict]
    model: str | None = None
    credentials: dict[str, str] | None = Field(default=None, repr=False)


# Mirrors AVAILABLE_MODELS in frontend/components/workspace/model-selector.tsx.
CODE_CHAT_MODELS = {
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3.8-27b",
}

class CodeFileUpdate(BaseModel):
    filename: str = Field(description="Name of the file to create or update")
    code: str = Field(description="The complete new or updated code for the file")
    description: str = Field(description="Short description of what the code does")
    category: str = Field(description="Category (firmware, driver, config, ai_ml)", default="firmware")
    language: str = Field(description="Language identifier (c, cpp, python, etc)", default="c")

class CodeChatResponse(BaseModel):
    reply: str = Field(description="Conversational reply to the user's prompt")
    updated_files: list[CodeFileUpdate] | None = Field(description="List of files to update or create, if any", default=None)
    # Set only when the safety gate blocked the turn. Internal: the Node backend
    # strips it before the response reaches the browser, and stores it.
    safety_audit: dict[str, Any] | None = None

@app.post("/api/v1/supervisor/code-chat", dependencies=[Depends(require_backend)])
def code_chat_endpoint(req: CodeChatRequest):
    """Specific endpoint for iterative code editing using Groq."""
    with use_credentials(req.credentials), capture_usage() as usage:
        result = _code_chat(req).model_dump()
        result["providerUsage"] = usage
        return result


def _code_chat(req: CodeChatRequest) -> CodeChatResponse:
    # The same safety gate as the design chat: this is a chat turn too, and it
    # writes firmware. Classified against the whole code-chat conversation.
    from safety_classifier import classify

    latest = next(
        (m.get("content") for m in reversed(req.messages) if m.get("role") == "user" and m.get("content")),
        None,
    )
    history = req.messages[:-1] if req.messages and req.messages[-1].get("content") == latest else req.messages
    verdict = classify(history, latest)
    if verdict.blocks:
        return CodeChatResponse(reply=verdict.message or "This request can't be processed.",
                                updated_files=None, safety_audit=verdict.audit())

    default_model = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
    model = req.model if req.model in CODE_CHAT_MODELS else default_model
    llm = ChatGroq(model=model, temperature=0.1, api_key=groq_api_key(), callbacks=[USAGE_CALLBACK])
    # gpt-oss needs method="json_schema": its Harmony tool-call format breaks the
    # "function_calling" method (it calls a tool literally named "json" and
    # LangChain rejects it as tool_use_failed) -- same fix as requirement_agent.py.
    # Groq only offers json_schema on gpt-oss, so the other models use tool calling.
    method = "json_schema" if model.startswith("openai/gpt-oss") else "function_calling"
    structured_llm = llm.with_structured_output(CodeChatResponse, method=method)

    # Format the current files as context
    context = "CURRENT FILES:\n"
    for f in req.files:
        context += f"\n--- {f.get('filename')} ---\n{f.get('code')}\n"
        
    system_msg = SystemMessage(content=
        "You are an expert embedded firmware and software engineer. You are chatting with a user about their generated code.\n"
        "1. Analyze the user's request carefully.\n"
        "2. Review the CURRENT FILES.\n"
        "3. If the user asks for code changes, rewrite the affected files entirely and return them in updated_files. If you return files, you MUST return the full code for them, not just snippets!\n"
        "4. If no files need changing, set updated_files to null.\n"
        "5. Keep your conversational reply concise and helpful."
    )

    chat_history = []
    for m in req.messages:
        if m.get("role") == "user":
            chat_history.append(HumanMessage(content=m.get("content", "")))
        else:
            chat_history.append(AIMessage(content=m.get("content", "")))

    # Insert context into the last user message
    if chat_history and isinstance(chat_history[-1], HumanMessage):
        chat_history[-1].content = f"{context}\n\nUSER REQUEST: {chat_history[-1].content}"
    else:
        chat_history.append(HumanMessage(content=f"{context}\\n\\nUSER REQUEST: Hello, review the code."))
        
    messages = [system_msg] + chat_history
    result = structured_llm.invoke(messages)
    return result


def main() -> None:
    import sys
    import uvicorn
    from pathlib import Path

    ai_engine_dir = Path(__file__).resolve().parent.parent.parent
    if str(ai_engine_dir) not in sys.path:
        sys.path.insert(0, str(ai_engine_dir))

    # PORT is what most hosts (Render, Railway, Cloud Run, Fly) inject; the
    # SUPERVISOR_* names stay for local setups that already use them. Set
    # SUPERVISOR_HOST=0.0.0.0 inside a container.
    host = os.getenv("SUPERVISOR_HOST", "127.0.0.1")
    port = int(os.getenv("PORT") or os.getenv("SUPERVISOR_PORT", "8000"))
    uvicorn.run(app, host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
