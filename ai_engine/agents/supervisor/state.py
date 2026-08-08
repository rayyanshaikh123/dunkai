"""Shared LangGraph state for the dunkai circuit design pipeline."""

from __future__ import annotations

from typing import Annotated, Any, TypedDict

from langgraph.graph.message import add_messages


def _merge_errors(existing: list[str] | None, new: list[str] | None) -> list[str]:
    merged = list(existing or [])
    for item in new or []:
        if item and item not in merged:
            merged.append(item)
    return merged


class CircuitState(TypedDict, total=False):
    """Single shared state object read and updated by every pipeline node."""

    requirements: dict[str, Any]
    architecture: dict[str, Any]
    bom: dict[str, Any]
    eda_data: dict[str, Any]
    pcb_ir: dict[str, Any]
    validation: dict[str, Any]
    documentation: dict[str, Any]
    messages: Annotated[list[Any], add_messages]
    errors: Annotated[list[str], _merge_errors]

    # Workflow control (optional; populated by the HTTP supervisor layer)
    user_input: str
    interview_history: list[Any]
    interview_status: str
    interview_question: str | None
    interview_options: list[str] | None
    interview_selection_mode: str
    build_quantity: int
    bom_csv_path: str
    design_name: str
    current_node: str
    workflow_status: str
