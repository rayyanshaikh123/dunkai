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
import re
from functools import lru_cache
from typing import Any, Literal

from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_groq import ChatGroq
try:
    from .usage_meter import USAGE_CALLBACK
except ImportError:
    from usage_meter import USAGE_CALLBACK
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

try:
    from .credentials import llm_api_key, llm_model
    from .llm import create_chat_model
    from .groq_limits import GroqQuotaExhausted, invoke_with_limits
except ImportError:  # imported as a top-level module by the supervisor
    from credentials import llm_api_key, llm_model
    from llm import create_chat_model
    from groq_limits import GroqQuotaExhausted, invoke_with_limits

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
# Four is a ceiling for an incomplete brief, not a mandatory number of turns.
# Ten remains the absolute safety limit even when a deployment raises the cap.
MAX_INTERVIEW_TURNS = min(10, max(1, int(os.getenv("REQUIREMENT_AGENT_MAX_TURNS", "4"))))
# How many recent chat messages to send back to the model each turn.
HISTORY_WINDOW = min(8, max(4, int(os.getenv("REQUIREMENT_AGENT_HISTORY_WINDOW", "8"))))


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

class HardwareRequirements(BaseModel):
    """Architecture-oriented requirements for the user's hardware project."""

    # "ignore", not "forbid": this is a best-effort LLM output boundary, not a
    # security boundary. gpt-oss-class models via Groq have been observed
    # bleeding stray top-level keys into the JSON they return -- schema
    # metadata like "additionalProperties": false leaking out of the JSON
    # Schema it was given and into the instance it produced. Failing the
    # whole turn over one unrecognised key the model invented is the wrong
    # trade: silently dropping anything not in this schema is what makes this
    # robust to the NEXT stray key too, not just the ones already seen.
    model_config = ConfigDict(extra="ignore")

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

    # See HardwareRequirements above: "ignore", not "forbid", for the same
    # reason -- a stray key the model invented (this exact class of bug
    # surfaced live as a literal "additionalProperties": false leaking into
    # the response) must never fail the whole turn.
    model_config = ConfigDict(extra="ignore")

    status: Literal["question", "complete"]
    question: str | None = None
    # The dict arm is deliberate and must stay in the annotation.
    #
    # Groq validates tool-call arguments against this model's JSON schema on
    # its own server and returns 400 tool_use_failed on a mismatch, so the
    # response never reaches Pydantic. A `mode="before"` validator alone
    # cannot rescue a bad shape -- the call has already failed a hop earlier.
    # Widening the schema is what lets the payload through to be normalised.
    #
    # Observed live: asked a grouped question, the model answered with one
    # option list per sub-question --
    #   {"parameters": [...], "power_source": [...], "budget": [...]}
    # -- and Groq rejected the whole turn with
    #   `/options`: expected array, but got object
    # which surfaced as "Requirement Agent failed" and ended the run.
    options: list[str] | dict[str, Any] | None = None
    selection_mode: Literal["single", "multiple"] = "multiple"
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
        """Reduce whatever the model sent to a flat list of choice labels.

        Covers three shapes seen from real providers:

        * a JSON string, sometimes wrapping the list in {"options": [...]};
        * a list whose items are dicts carrying label/text/value;
        * a dict keyed by sub-question, one option list per facet, which Groq
          rejects outright (see the `options` annotation above).

        The grouped dict is FLATTENED rather than discarded. The chips are
        multi-select (`selection_mode`, and `toggleOption` in the chat UI), so
        the user can pick one choice from each facet and the send path joins
        them; collapsing the facets loses nothing they could not express.
        """
        if value is None:
            return None

        if isinstance(value, str):
            try:
                parsed = json.loads(value.strip())
            except json.JSONDecodeError:
                parsed = [value]
            value = parsed

        if isinstance(value, dict):
            # A provider wrapper names the list; a grouped question does not.
            inner = value.get("options")
            value = inner if inner is not None else list(value.values())

        if not isinstance(value, (list, tuple)):
            return None

        labels: list[str] = []
        for item in value:
            # One nesting level, from the same per-facet grouping habit.
            items = item if isinstance(item, (list, tuple)) else [item]
            for entry in items:
                if isinstance(entry, dict):
                    entry = entry.get("label") or entry.get("text") or entry.get("value")
                if entry is None:
                    continue
                label = str(entry).strip()
                if label and label not in labels:
                    labels.append(label)
        return labels[:6] if labels else None

    @model_validator(mode="after")
    def validate_interview_shape(self) -> "InterviewResponse":
        if self.status == "question":
            if not self.question or not self.question.strip():
                raise ValueError("question status requires a question")
            if self.requirements is not None:
                # gpt-oss-class models sometimes journal what they've learned so
                # far into `requirements` (mostly null, one or two fields filled)
                # even while still asking a follow-up question. That's progress
                # tracking, not a signal the interview is done -- only
                # `status == "complete"` means that. Rejecting the whole
                # response over it used to fail Pydantic validation and lose
                # the answer the user had just submitted; discarding the
                # premature requirements here keeps the well-formed question.
                self.requirements = None

            # Capped, but deliberately NOT padded. A previous revision topped
            # every short list up to three with generic strings ("Standard
            # Baseline", "High Performance Mode", ...). Those are not answers to
            # the question asked: clicking one sends it back as the user's real
            # answer and it lands in the requirements that drive the whole
            # pipeline. run_interview asks the model for real,
            # project-specific choices instead, via _get_option_chain.
            self.options = list(self.options or [])[:6] or None

        elif self.requirements is None:
            raise ValueError("complete status requires requirements")
        return self


class QuestionOptions(BaseModel):
    options: list[str] = Field(min_length=2, max_length=6)


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT_TEMPLATE = """
Every question MUST include 3 to 6 concise, separated, atomic multiple-choice options (for example: individual features, individual sensors, specific communication protocols, power sources, or physical constraints).
Keep each option short (1 to 5 words), atomic, and independently selectable so the user can select multiple options according to their specific requirements. Do NOT combine multiple unrelated options into a single long paragraph option.

Set selection_mode to "multiple" by default so the user can check off multiple choices at once.

Return options as a flat JSON array of strings, or null -- never an object keyed by sub-question, and never a list of lists. When a question covers several details, flatten every choice into that one array; the user can select more than one.

You are dunkai's Requirement Analysis Agent. dunkai is the software product, not the user's hardware project.

Architecture-first completion rule: extract facts already supplied in the brief and prior answers. If they are sufficient to select an architecture, return status "complete" on this turn, even if you have asked zero questions. Otherwise ask only the highest-value missing question. Never ask for a fact the user has already supplied. Ask at most {max_turns} questions. Check these domains as relevant to the project:
1. System workflow, target users, and main functional objectives
2. Hardware inputs, sensors, switches, and signal sources
3. Hardware outputs, displays, indicators, motors, and actuators
4. Connectivity (BLE, WiFi, Cellular, USB, Ethernet) and host platforms
5. Power supply (battery, solar, DC, USB-C), power budget, and thermal/physical constraints
6. Performance specifications, sample rates, safety & regulatory compliance

Objective, hardware inputs and outputs, and power source are usually needed to choose a circuit. Connectivity, physical limits, performance and compliance matter when the project calls for them. Do not invent unknown values; leave nonessential fields null. For a detailed brief, zero to two follow-up questions should normally suffice. A sparse brief may need up to four.

Treat the entire conversation as cumulative state: preserve every fact from earlier user answers, merge the latest answer into existing requirements, and never replace known values with null.

Never hallucinate. Do not recommend specific chip part numbers or design PCB traces in this phase.

Return only the structured response represented by the Pydantic schema. For complete responses, set question and options to null.
"""

SYSTEM_PROMPT = _SYSTEM_PROMPT_TEMPLATE.format(max_turns=MAX_INTERVIEW_TURNS)

# ---------------------------------------------------------------------------
# Lazy, cached client/chain construction
#
# Nothing below runs at import time. Each factory is memoized so the Groq
# client and prompt/chain objects are built once per (model, key) and reused.
# The key is part of the cache key on purpose: with BYOK, two requests can hold
# different keys, and a cache keyed on the model alone would hand one user's
# client -- and so their key -- to the next caller.
# ---------------------------------------------------------------------------

@lru_cache(maxsize=32)
def _get_llm(model: str | None, api_key: str) -> ChatGroq:
    return create_chat_model(model=model or MODEL_NAME, api_key=api_key, temperature=TEMPERATURE, max_retries=2, callbacks=[USAGE_CALLBACK])


_OPTION_SYSTEM_PROMPT = (
    "Generate 3 to 6 useful answer choices for the question. Choices must be "
    "specific to this hardware project and to the question asked, short (1-5 "
    "words), atomic and independently selectable, so the user may pick several. "
    "Do not answer the question. Return only the options field."
)


@lru_cache(maxsize=32)
def _option_chain(model: str | None, api_key: str):
    option_prompt = ChatPromptTemplate.from_messages([
        ("system", _OPTION_SYSTEM_PROMPT),
        ("human", "Question: {question}"),
    ])
    return option_prompt | _get_llm(model, api_key).with_structured_output(QuestionOptions, method="json_schema")


@lru_cache(maxsize=32)
def _interview_chain(model: str | None, api_key: str):
    prompt = ChatPromptTemplate.from_messages([
        ("system", SYSTEM_PROMPT),
        MessagesPlaceholder("history"),
        ("human", "{input}"),
    ])
    return prompt | _get_llm(model, api_key).with_structured_output(InterviewResponse, method="json_schema")


def _get_option_chain(model: str | None = None):
    return _option_chain(llm_model(model), llm_api_key())


def _get_interview_chain(model: str | None = None):
    return _interview_chain(llm_model(model), llm_api_key())


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
    """Cap detailed briefs at two questions and sparse briefs at four.

    Use the initial brief, not the growing conversation: a changing cap could
    end an interview immediately after the user answers a follow-up.
    """
    initial_brief = user_input
    for item in history or []:
        if isinstance(item, dict) and item.get("role") == "user":
            initial_brief = str(item.get("content") or "")
            break
        elif isinstance(item, (list, tuple)) and item and item[0]:
            initial_brief = str(item[0])
            break
    text = initial_brief.lower()
    domains = (
        ("battery", "power", "charging", "solar", "mains"),
        ("wifi", "wi-fi", "bluetooth", "ble", "cellular", "ethernet", "usb", "offline"),
        ("sensor", "camera", "microphone", "gps", "input", "button", "switch"),
        ("display", "led", "motor", "relay", "speaker", "output", "buzzer"),
        ("wearable", "portable", "enclosure", "size", "dimensions", "outdoor"),
    )
    covered_domains = sum(any(re.search(r"\b" + re.escape(term) + r"\b", text) for term in domain) for domain in domains)
    detailed = len(text.split()) >= 25 and covered_domains >= 4
    return min(MAX_INTERVIEW_TURNS, 2 if detailed else 4)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def run_interview(user_input: str, history: list[Any] | None = None, model: str | None = None) -> InterviewResponse:
    """Advance the interview by one turn.

    Usually makes one LLM call. A question with missing choices can trigger
    one additional call for project-specific options.
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
                f"The project-specific target of {budget} questions has been reached. You MUST "
                "return status complete now using the gathered facts; leave unknown values null.\n"
            )
        else:
            turn_instruction = (
                f"You have asked {asked} questions; the project-specific ceiling is {budget}. "
                "Return status complete now if the facts already support an architecture. "
                "Otherwise ask the highest-value unanswered architecture question.\n"
            )
        current_input = turn_instruction + "\nCURRENT USER ANSWER:\n" + user_input.strip()

        payload = {"history": to_langchain_history(history), "input": current_input}
        # Rate limits are handled in groq_limits: a per-minute limit waits, a
        # spent daily allowance moves on to a fallback model. `model` becomes
        # whichever one answered, so the options call below uses it too.
        result, model = invoke_with_limits(
            lambda name: _get_interview_chain(name).invoke(payload),
            model or MODEL_NAME,
            agent="Requirement Agent",
        )
        response = InterviewResponse.model_validate(result)

        if asked >= MAX_INTERVIEW_TURNS and response.status == "question":
            raise RuntimeError("Interview question limit reached without a complete requirements response.")
        # The model is asked for 3-6 options, but does not always comply. A
        # second, cheap call asks for real ones rather than inventing filler;
        # if it fails, the question is simply open-ended, which is honest.
        if response.status == "question" and response.question and len(response.options or []) < 3:
            try:
                generated = _get_option_chain(model).invoke({"question": response.question})
                options = QuestionOptions.model_validate(generated).options
                if options:
                    response = response.model_copy(update={"options": options})
            except Exception:
                pass

        return response
    except (ValidationError, GroqQuotaExhausted):
        # The quota message is already written for the user; wrapping it in
        # "LangChain/Groq interview failed: ..." would only bury it.
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
