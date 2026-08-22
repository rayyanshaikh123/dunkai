"""FastAPI Supervisor HTTP server for the dunkai LangGraph pipeline.

The Node.js backend talks only to this endpoint. Individual agents remain
internal and are invoked through graph nodes or direct node wrappers.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

try:
    from .graph import compile_graph, run_workflow, stream_workflow
    from .nodes import (
        architecture_node,
        component_node,
        documentation_node,
        eda_enrichment_node,
        pcb_node,
        requirements_node,
        validation_node,
    )
    from .state import CircuitState, _merge_errors
except ImportError:
    from graph import compile_graph, run_workflow, stream_workflow
    from nodes import (
        architecture_node,
        component_node,
        documentation_node,
        eda_enrichment_node,
        pcb_node,
        requirements_node,
        validation_node,
    )
    from state import CircuitState, _merge_errors

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="dunkai Supervisor Agent", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SINGLE_NODE_ACTIONS = {
    "generate_requirements": requirements_node,
    "generate_architecture": architecture_node,
    "generate_components": component_node,
    "generate_eda": eda_enrichment_node,
    "generate_pcb": pcb_node,
    "generate_validation": validation_node,
    "generate_documentation": documentation_node,
}


class SupervisorRequest(BaseModel):
    action: str = "run_workflow"
    project: dict[str, Any] | str | None = None
    messages: list[dict[str, Any]] = Field(default_factory=list)
    files: list[Any] = Field(default_factory=list)
    jobId: str | None = None
    agentType: str | None = None


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

    for key in ("bom", "eda_data", "pcb_ir", "validation", "handoff_validation", "documentation"):
        value = project.get(key)
        if isinstance(value, dict) and value:
            state[key] = value  # type: ignore[literal-required]

    if isinstance(project.get("bom_csv_path"), str):
        state["bom_csv_path"] = project["bom_csv_path"]

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
        "messages": messages,
        "errors": state.get("errors") or [],
        "workflow_status": state.get("workflow_status"),
        "interview_status": state.get("interview_status"),
        "interview_question": state.get("interview_question"),
        "interview_options": state.get("interview_options"),
        "current_node": state.get("current_node"),
        "bom_csv_path": state.get("bom_csv_path"),
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


def _run_single_node(action: str, state: CircuitState) -> CircuitState:
    node_fn = SINGLE_NODE_ACTIONS.get(action)
    if node_fn is None:
        raise HTTPException(status_code=400, detail=f"Unknown action: {action}")

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
    final_state = _run_single_node(action, state)
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


@app.post("/api/v1/supervisor")
def supervisor_endpoint(payload: SupervisorRequest) -> dict[str, Any]:
    action = payload.action or "run_workflow"
    job_id = payload.jobId or str(uuid.uuid4())

    logger.info("Supervisor action=%s jobId=%s", action, job_id)

    if action == "chat":
        return {"data": _handle_chat(payload), "jobId": job_id}

    if action == "run_workflow":
        initial_state = _build_initial_state(payload)
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
    "requirements": "Analysing requirements",
    "architecture": "Generating architecture",
    "component": "Selecting components & building BOM",
    "eda_enrichment": "Enriching EDA data",
    "pcb": "Generating PCB layout",
    "validation": "Running validation checks",
    "documentation": "Compiling documentation",
}


def _sse_event(data: dict[str, Any], event: str = "progress") -> str:
    """Format a single SSE event line.  Always ends with a double newline."""
    payload = json.dumps(data, default=str)
    return f"event: {event}\ndata: {payload}\n\n"


def _stream_generator(payload: SupervisorRequest):
    """Yield SSE text chunks as the LangGraph pipeline progresses.

    Each node completion produces an ``event: progress`` chunk.
    If an agent raises, we yield ``event: error`` so the consumer knows
    the stream failed *after* the HTTP 200 was already sent.
    On success the final chunk is ``event: complete`` with the full state.
    """
    job_id = payload.jobId or str(uuid.uuid4())
    initial_state = _build_initial_state(payload)

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


@app.post("/api/v1/supervisor/stream")
def supervisor_stream_endpoint(payload: SupervisorRequest):
    """SSE streaming variant of the supervisor endpoint.

    Returns ``text/event-stream`` so the Node.js backend can read
    progress events as they arrive and relay them over Socket.io.
    """
    return StreamingResponse(
        _stream_generator(payload),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # Disable nginx buffering if proxied.
        },
    )


def main() -> None:
    import sys
    import uvicorn
    from pathlib import Path

    ai_engine_dir = Path(__file__).resolve().parent.parent.parent
    if str(ai_engine_dir) not in sys.path:
        sys.path.insert(0, str(ai_engine_dir))

    host = os.getenv("SUPERVISOR_HOST", "127.0.0.1")
    port = int(os.getenv("SUPERVISOR_PORT", "8000"))
    uvicorn.run(app, host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
