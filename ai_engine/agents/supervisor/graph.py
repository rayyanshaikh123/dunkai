"""LangGraph workflow builder for the dunkai hardware design pipeline."""

from __future__ import annotations

from typing import Generator, Literal

from langgraph.graph import END, START, StateGraph

try:
    from .nodes import (
        architecture_node,
        component_node,
        documentation_node,
        eda_enrichment_node,
        pcb_node,
        requirements_node,
        supervisor_node,
        validation_node,
    )
    from .state import CircuitState
except ImportError:
    from nodes import (
        architecture_node,
        component_node,
        documentation_node,
        eda_enrichment_node,
        pcb_node,
        requirements_node,
        supervisor_node,
        validation_node,
    )
    from state import CircuitState


def _route_after_requirements(state: CircuitState) -> Literal["architecture", "__end__"]:
    if state.get("errors"):
        return END
    if state.get("interview_status") == "question":
        return END
    if not state.get("requirements"):
        return END
    return "architecture"


def build_graph() -> StateGraph:
    """Construct the linear supervisor pipeline with a requirements gate."""
    graph = StateGraph(CircuitState)

    graph.add_node("supervisor", supervisor_node)
    graph.add_node("requirements", requirements_node)
    graph.add_node("architecture", architecture_node)
    graph.add_node("component", component_node)
    graph.add_node("eda_enrichment", eda_enrichment_node)
    graph.add_node("pcb", pcb_node)
    graph.add_node("validation", validation_node)
    graph.add_node("documentation", documentation_node)

    graph.add_edge(START, "supervisor")
    graph.add_edge("supervisor", "requirements")
    graph.add_conditional_edges("requirements", _route_after_requirements)
    graph.add_edge("architecture", "component")
    graph.add_edge("component", "eda_enrichment")
    graph.add_edge("eda_enrichment", "pcb")
    graph.add_edge("pcb", "validation")
    graph.add_edge("validation", "documentation")
    graph.add_edge("documentation", END)

    return graph


from functools import lru_cache


@lru_cache(maxsize=1)
def compile_graph():
    """Return a compiled LangGraph runnable (singleton cached)."""
    return build_graph().compile()


def run_workflow(initial_state: CircuitState | None = None) -> CircuitState:
    """Execute the full pipeline and return the final state."""
    app = compile_graph()
    return app.invoke(initial_state or {})


def stream_workflow(
    initial_state: CircuitState | None = None,
) -> Generator[tuple[str, CircuitState], None, None]:
    """Yield ``(node_name, state_snapshot)`` after each node completes.

    This is the streaming counterpart to :func:`run_workflow`.  The
    compiled LangGraph ``stream()`` method returns an iterator of
    ``{node_name: partial_update}`` dicts.  We merge each update into a
    running state copy and yield the pair so callers can serialise
    progress events without touching the graph internals.
    """
    app = compile_graph()
    state: CircuitState = dict(initial_state or {})

    for chunk in app.stream(state):
        # chunk is {node_name: partial_state_update}
        for node_name, update in chunk.items():
            if isinstance(update, dict):
                for key, value in update.items():
                    if key == "messages":
                        state["messages"] = list(state.get("messages") or []) + list(value or [])
                    elif key == "errors":
                        try:
                            from .state import _merge_errors
                        except ImportError:
                            from state import _merge_errors
                        state["errors"] = _merge_errors(state.get("errors"), value)
                    else:
                        state[key] = value  # type: ignore[literal-required]
            yield node_name, dict(state)

