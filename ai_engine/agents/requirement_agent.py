"""dunkai Requirement Analysis Agent.

Pure LangChain + Groq module that turns a hardware project idea into a
validated ``HardwareRequirements`` object through a short, adaptive
structured-output QA interview.

Design notes (kept deliberately strict to avoid wasting LLM calls):

* **No import-time side effects.** The Groq client and both LangChain
  chains are built lazily via ``@lru_cache``-backed factories. Importing
  this module (e.g. for its schema, or from a test) never opens a
  network client, and never raises just because ``GROQ_API_KEY`` isn't
  set yet -- that check only fires the first time a chain is actually
  used.
* **Singletons, not rebuilds.** The client/chains are constructed once
  per process and reused on every turn, instead of re-instantiating a
  ``ChatGroq`` client (and re-parsing the prompt templates) on every
  single call.
* **One LLM call per turn, by default.** ``run_interview`` makes exactly
  one structured-output call to the interview chain. It only makes a
  second call -- to backfill multiple-choice options -- when the model's
  own response was a question *and* it didn't already supply options.
  When the model already gave options (the common case, since the system
  prompt asks for them), there is no second call.
* **Bounded, capped history.** Conversation history sent to the model is
  trimmed to a fixed window (``HISTORY_WINDOW`` messages) so token cost
  per call doesn't grow unbounded over a long interview.
* **No UI or evaluation code lives here.** This module is pure agent
  logic so it can be imported by a Gradio app, an evaluation harness, or
  another agent without pulling in unrelated dependencies or launching a
  UI as a side effect.
"""

from __future__ import annotations

import ast
import json
import os
from functools import lru_cache
from typing import Any, Literal

from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_groq import ChatGroq
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

__all__ = [
    "HardwareRequirements",
    "InterviewResponse",
    "QuestionOptions",
    "run_interview",
    "respond",
    "to_langchain_history",
]

# ---------------------------------------------------------------------------
# Configuration (env-overridable; nothing here touches the network)
# ---------------------------------------------------------------------------

MODEL_NAME = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
TEMPERATURE = float(os.getenv("REQUIREMENT_AGENT_TEMPERATURE", "0.2"))
MIN_INTERVIEW_TURNS = min(10, max(1, int(os.getenv("REQUIREMENT_AGENT_MIN_TURNS", "2"))))
# Ten is a product limit, not a deployment default. The dynamic per-project
# budget below normally completes much sooner; this is the absolute guardrail.
MAX_INTERVIEW_TURNS = 10
# How many recent chat messages to send back to the model each turn. Keeps
# per-call token cost (and therefore $ and latency) bounded on long interviews.
# Keep enough context for the current decision while avoiding the rapidly
# growing prompt that can exhaust a provider's token-per-minute allowance.
HISTORY_WINDOW = min(8, max(4, int(os.getenv("REQUIREMENT_AGENT_HISTORY_WINDOW", "8"))))


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

class HardwareRequirements(BaseModel):
    """Architecture-oriented requirements for the user's hardware project."""

    model_config = ConfigDict(extra="forbid")

    project_name: str | None = Field(default=None, description="Name of the user's hardware project")
    category: str | None = None
    objective: str | None = None
    # The unions keep Groq's tool schema tolerant of scalar/dict variants.
    # Validators below normalize them into the clean list/string output.
    target_users: list[str] | str | dict[str, Any] | None = None
    functional_requirements: list[str] | str | dict[str, Any] | None = None
    hardware_inputs: list[str] | str | dict[str, Any] | None = None
    hardware_outputs: list[str] | str | dict[str, Any] | None = None
    connectivity: list[str] | str | dict[str, Any] | None = None
    supported_platforms: list[str] | str | dict[str, Any] | None = None
    power_requirements: str | list[str] | dict[str, Any] | None = None
    physical_constraints: list[str] | str | dict[str, Any] | None = None
    performance_requirements: list[str] | str | dict[str, Any] | None = None
    safety_compliance: list[str] | str | dict[str, Any] | None = None
    budget: str | int | float | None = None

    @field_validator("project_name", "category", "objective", "power_requirements", "budget", mode="before")
    @classmethod
    def normalize_scalar(cls, value):
        if value is None:
            return None
        if isinstance(value, str):
            text = value.strip()
            if text.lower() in {"", "null", "none", "unknown"}:
                return None
            if text.startswith("[") and text.endswith("]"):
                try:
                    parsed = json.loads(text)
                except json.JSONDecodeError:
                    try:
                        parsed = ast.literal_eval(text)
                    except (ValueError, SyntaxError):
                        parsed = text
                if isinstance(parsed, list):
                    return str(parsed[0]) if parsed and parsed[0] is not None else None
        return str(value)

    @field_validator(
        "target_users", "functional_requirements", "hardware_inputs",
        "hardware_outputs", "connectivity", "supported_platforms",
        "physical_constraints",
        "performance_requirements", "safety_compliance", mode="before"
    )
    @classmethod
    def normalize_list(cls, value):
        if value is None:
            return None
        if isinstance(value, dict):
            value = [f"{key}: {item}" for key, item in value.items() if item is not None]
        elif isinstance(value, str):
            text = value.strip()
            if text.lower() in {"", "null", "none", "unknown", "[]"}:
                return None
            if text.startswith("[") and text.endswith("]"):
                try:
                    value = json.loads(text)
                except json.JSONDecodeError:
                    try:
                        value = ast.literal_eval(text)
                    except (ValueError, SyntaxError):
                        value = [text]
            else:
                value = [text]
        values = [str(item).strip() for item in value if item is not None and str(item).strip()]
        return values or None


class InterviewResponse(BaseModel):
    """One question or the final validated requirements object."""

    model_config = ConfigDict(extra="forbid")

    status: Literal["question", "complete"]
    question: str | None = None
    options: list[str] | None = None
    selection_mode: Literal["single", "multiple"] = "single"
    requirements: HardwareRequirements | None = None

    @model_validator(mode="before")
    @classmethod
    def infer_status(cls, data: dict) -> dict:
        if "status" not in data:
            data["status"] = "complete" if data.get("requirements") else "question"
        return data

    @field_validator("options", mode="before")
    @classmethod
    def normalize_options(cls, value: Any) -> list[str] | None:
        """Normalize provider wrappers into human-readable option labels."""
        if value is None:
            return None
        if isinstance(value, str):
            try:
                parsed = json.loads(value.strip())
            except json.JSONDecodeError:
                parsed = [value]
            value = parsed.get("options") if isinstance(parsed, dict) else parsed
        if not isinstance(value, list):
            return None
        labels: list[str] = []
        for item in value:
            if isinstance(item, dict):
                item = item.get("label") or item.get("text") or item.get("value")
            if isinstance(item, str):
                label = item.strip()
                if label and label not in labels:
                    labels.append(label)
        return labels[:4] if labels else None

    @model_validator(mode="after")
    def validate_interview_shape(self) -> "InterviewResponse":
        if self.status == "question":
            if not self.question or not self.question.strip():
                raise ValueError("question status requires a question")
            if self.requirements is not None:
                raise ValueError("question status cannot include final requirements")
            
            # Ensure 2 to 4 options are ALWAYS present for user interaction
            opts = list(self.options or [])
            if len(opts) < 2:
                defaults = ["Standard baseline configuration", "High-performance / custom setup", "Low-power / compact mode", "Full-featured expansion mode"]
                for default_opt in defaults:
                    if default_opt not in opts:
                        opts.append(default_opt)
                    if len(opts) >= 2:
                        break
            self.options = opts[:4]

        elif self.requirements is None:
            raise ValueError("complete status requires requirements")
        return self


class QuestionOptions(BaseModel):
    options: list[str] = Field(min_length=2, max_length=4)


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT_TEMPLATE = """
Every question MUST include 2 to 4 concise, mutually distinct multiple-choice options. Each option must be a plain human-readable label of at most 12 words, never JSON, a key/value pair, or an explanation. The user can always type a custom answer, so do not add an "Other" option.

Set selection_mode to "single" by default: this gives the user one clear answer to a normal decision. Use selection_mode "multiple" ONLY for a deliberate master question that gathers two or more independent, related fields in one turn, such as budget plus display size, or selected sensors plus selected indicators. For a multiple master question, each option must be an independently selectable answer fragment and identify its field when needed (for example, "Budget: under $200" or "Display: 2.4-inch LCD"). Never use multiple just because a question has several words or because its options are alternative profiles.

You are dunkai's Requirement Analysis Agent. dunkai is the software product, not the user's hardware project.

Architecture-first completion rule: conduct a short, project-specific interview. The user message provides a target question budget based on project complexity; use only as many questions as needed, never more than {max_turns}. Use high-yield grouped questions instead of one question per schema field. Cover the unresolved architecture-critical areas: (1) user workflow and main functions, (2) physical inputs and sensing, (3) physical outputs and interaction, (4) connectivity, processing location, and host platforms, and (5) power, battery life, physical constraints, performance, and safety. Combine related topics into one concise project-specific question. Do not invent exact components or specifications.

Ask exactly one concise grouped follow-up question per turn. A grouped question may ask several closely related details that together affect architecture. Do not repeat questions or ask narrow low-value questions. Treat the entire conversation as cumulative state: preserve every fact from earlier user answers, merge the latest answer into the existing requirements, and never replace known values with null. Map answers explicitly into the appropriate fields, especially hardware_inputs, hardware_outputs, functional_requirements, connectivity, and power_requirements. Complete as soon as the unresolved architecture-critical details are sufficient; do not ask filler questions to reach a quota.

Ask only about information that can affect architecture, hardware inputs/outputs, connectivity, supported platforms, power, physical constraints, performance, safety, or budget. Do not ask generic questions when a project-specific question is possible. Do not repeat answered questions. If the latest answer is vague or does not answer the previous question, clarify it instead of changing the project.

Never hallucinate. Do not change the project domain. Unknown values must be null. Do not recommend components, design circuits, or generate firmware. Never ask more than {max_turns} questions total.

Return only the structured response represented by the Pydantic schema. For complete responses, set question and options to null.
"""

SYSTEM_PROMPT = _SYSTEM_PROMPT_TEMPLATE.format(min_turns=MIN_INTERVIEW_TURNS, max_turns=MAX_INTERVIEW_TURNS)

# ---------------------------------------------------------------------------
# Lazy, cached client/chain construction
#
# Nothing below runs at import time. Each factory is memoized so the Groq
# client and prompt/chain objects are built exactly once per process and
# reused on every subsequent call, no matter how many times run_interview()
# is invoked.
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _get_llm() -> ChatGroq:
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise EnvironmentError("Set GROQ_API_KEY before running the Requirement Agent.")
    return ChatGroq(model=MODEL_NAME, groq_api_key=api_key, temperature=TEMPERATURE, max_retries=2)


@lru_cache(maxsize=1)
def _get_interview_chain():
    prompt = ChatPromptTemplate.from_messages([
        ("system", SYSTEM_PROMPT),
        MessagesPlaceholder("history"),
        ("human", "{input}"),
    ])
    return prompt | _get_llm().with_structured_output(InterviewResponse)


# ---------------------------------------------------------------------------
# History helpers
# ---------------------------------------------------------------------------

def to_langchain_history(history: list[Any] | None) -> list[Any]:
    """Convert Gradio-style history (dicts or (user, bot) tuples) to LangChain messages.

    Trimmed to the last ``HISTORY_WINDOW`` messages to bound token cost.
    """
    messages: list[Any] = []
    for item in history or []:
        if isinstance(item, dict):
            role, content = item.get("role"), item.get("content")
            if role == "user" and content:
                messages.append(HumanMessage(content=str(content)))
            elif role == "assistant" and content:
                messages.append(AIMessage(content=str(content)))
        elif isinstance(item, (list, tuple)) and len(item) == 2:
            if item[0]:
                messages.append(HumanMessage(content=str(item[0])))
            if item[1]:
                messages.append(AIMessage(content=str(item[1])))
    return messages[-HISTORY_WINDOW:]


def _asked_question_count(history: list[Any] | None) -> int:
    """Count prior assistant turns that were questions (not final JSON)."""
    count = 0
    for item in history or []:
        content = (
            item.get("content") if isinstance(item, dict) and item.get("role") == "assistant"
            else (item[1] if isinstance(item, (list, tuple)) and len(item) == 2 else None)
        )
        if isinstance(content, str) and content.strip() and not content.lstrip().startswith("{"):
            count += 1
    return count


def _interview_budget(user_input: str, history: list[Any] | None = None) -> int:
    """Return a small, complexity-aware interview budget, capped at ten."""
    user_text = [user_input]
    for item in history or []:
        if isinstance(item, dict) and item.get("role") == "user":
            user_text.append(str(item.get("content") or ""))
        elif isinstance(item, (list, tuple)) and item and item[0]:
            user_text.append(str(item[0]))
    text = " ".join(user_text).lower()
    domains = (
        ("battery", "power", "charging", "solar"),
        ("wifi", "bluetooth", "ble", "cellular", "ethernet", "usb", "cloud"),
        ("sensor", "camera", "microphone", "gps", "input"),
        ("display", "led", "motor", "relay", "speaker", "output"),
        ("wearable", "portable", "enclosure", "size", "temperature", "outdoor"),
        ("medical", "safety", "certif", "industrial", "automotive"),
        ("latency", "accuracy", "sampling", "performance", "real-time"),
    )
    covered_domains = sum(any(term in text for term in domain) for domain in domains)
    detail_bonus = 1 if len(text.split()) > 35 else 0
    # Two questions for a narrow brief, progressing to eight for a complex one.
    return min(MAX_INTERVIEW_TURNS, max(MIN_INTERVIEW_TURNS, 2 + covered_domains // 2 + detail_bonus))


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def run_interview(user_input: str, history: list[Any] | None = None) -> InterviewResponse:
    """Advance the interview by one turn.

    Makes exactly one LLM call. Every question is schema-validated to include
    2-4 clean, selectable answer choices.
    """
    if not user_input or not user_input.strip():
        raise ValueError("Please enter a hardware project idea.")

    try:
        asked = _asked_question_count(history)
        budget = _interview_budget(user_input, history)
        if asked >= MAX_INTERVIEW_TURNS:
            turn_instruction = (
                f"You have already asked {MAX_INTERVIEW_TURNS} questions. You MUST now return "
                "status complete using only facts gathered so far; leave unknown values null.\n"
            )
        elif asked >= budget:
            turn_instruction = (
                f"The project-specific hard limit of {budget} questions has been reached. You MUST "
                "return status complete now using the gathered facts; leave unknown values null.\n"
            )
        else:
            turn_instruction = (
                f"This is follow-up question {asked + 1}; the project-specific target is about {budget} "
                f"questions and the absolute maximum is {MAX_INTERVIEW_TURNS}. Ask the highest-value "
                "unanswered architecture question.\n"
            )
        current_input = turn_instruction + "\nCURRENT USER ANSWER:\n" + user_input.strip()

        result = _get_interview_chain().invoke({
            "history": to_langchain_history(history),
            "input": current_input,
        })
        response = InterviewResponse.model_validate(result)

        if asked >= min(budget, MAX_INTERVIEW_TURNS) and response.status == "question":
            raise RuntimeError("Interview question limit reached without a complete requirements response.")

        return response
    except ValidationError:
        raise
    except Exception as exc:
        raise RuntimeError(f"LangChain/Groq interview failed: {exc}") from exc


def respond(user_input: str, history: list[Any] | None = None) -> str:
    """Convenience wrapper returning plain text: the next question, or final JSON."""
    result = run_interview(user_input, history)
    if result.status == "question":
        return result.question or "Please provide one more project detail."
    assert result.requirements is not None
    return result.requirements.model_dump_json(indent=2, exclude_none=True)
