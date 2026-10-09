"""Groq rate-limit handling shared by the Requirement and Architecture agents.

Groq enforces two different kinds of limit, and they need opposite responses:

* **Per-minute** (TPM/RPM): "try again in 1.2s". Waiting that long works.
* **Per-day** (TPD/RPD): "try again in 5m43s" on a rolling 24h window, with the
  day's allowance already spent. Waiting does not work -- by the time a few
  minutes pass, the next request needs more tokens than have come back. Each
  model has its OWN daily allowance, though, so another model does work.

Both agents used to treat every 429 the same way: retry the same model up to
five times. The wait was parsed with ``try again in ([\\d.]+)s``, which cannot
read "5m43.008s", so on a daily limit it fell back to blind 3.5s..17.5s sleeps,
spent ~50s, and then surfaced Groq's raw JSON error in the chat.

Now a daily limit moves straight on to the next model in GROQ_FALLBACK_MODELS,
a per-minute limit waits for the time Groq actually asked for, and when every
model is exhausted the error says so in words a user can act on.
"""

from __future__ import annotations

import logging
import os
import re
import time
from typing import Callable, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")

#: Tried in order after the requested model. Each Groq model has its own quota,
#: so these keep the pipeline running when the default model's day is used up.
#: Set GROQ_FALLBACK_MODELS="" to disable fallback entirely.
DEFAULT_FALLBACK_MODELS = "openai/gpt-oss-20b,qwen/qwen3.8-27b"

#: Longest per-minute wait worth sitting through before trying another model.
MAX_WAIT_SECONDS = 60.0
ATTEMPTS_PER_MODEL = 4

_DAILY_MARKERS = ("per day", "(tpd)", "(rpd)")
_DURATION = re.compile(r"try again in ((?:[\d.]+(?:h|ms|m|s))+)", re.IGNORECASE)
_DURATION_PART = re.compile(r"([\d.]+)(h|ms|m|s)", re.IGNORECASE)
_UNIT_SECONDS = {"h": 3600.0, "m": 60.0, "s": 1.0, "ms": 0.001}


class GroqQuotaExhausted(RuntimeError):
    """Every candidate model is rate-limited. The message is meant for the user."""


def is_rate_limit(text: str) -> bool:
    lowered = text.lower()
    return "429" in text or "rate_limit_exceeded" in lowered or "too many requests" in lowered


def is_daily_limit(text: str) -> bool:
    lowered = text.lower()
    return any(marker in lowered for marker in _DAILY_MARKERS)


def retry_after_seconds(text: str) -> float | None:
    """Parse Groq's "try again in 5m43.008s" / "1.2s" / "250ms" into seconds."""
    match = _DURATION.search(text)
    if not match:
        return None
    return sum(float(value) * _UNIT_SECONDS[unit.lower()] for value, unit in _DURATION_PART.findall(match.group(1)))


def candidate_models(requested: str, fallbacks: list[str] | None = None) -> list[str]:
    """The requested model, then its fallbacks: an explicit list, else GROQ_FALLBACK_MODELS."""
    if fallbacks is None:
        raw = os.getenv("GROQ_FALLBACK_MODELS", DEFAULT_FALLBACK_MODELS)
        fallbacks = [m.strip() for m in raw.split(",") if m.strip()]
    return [requested] + [m for m in fallbacks if m != requested]


def _describe_wait(seconds: float | None) -> str:
    if seconds is None:
        return ""
    minutes, secs = divmod(int(round(seconds)), 60)
    return f", frees up in ~{minutes}m {secs:02d}s" if minutes else f", frees up in ~{secs}s"


def invoke_with_limits(
    call: Callable[[str], T], model: str, *, agent: str, fallbacks: list[str] | None = None
) -> tuple[T, str]:
    """Run ``call(model_name)``, handling Groq rate limits.

    Returns ``(result, model_actually_used)``. Errors that are not rate limits
    are raised unchanged, on the first attempt -- only 429s are handled here.
    ``fallbacks`` overrides GROQ_FALLBACK_MODELS for callers that need their
    own list (the safety classifier falls back to a classifier-capable model,
    not to whatever the design agents use).
    """
    try:
        from .credentials import llm_provider, llm_model, selected_model
    except ImportError:
        from credentials import llm_provider, llm_model, selected_model
    if llm_provider() == "openai":
        # The OpenAI SDK handles its bounded retries. Never route a GPT key
        # to Groq, or switch a BYOK request to an operator-funded provider.
        selected = llm_model(model)
        return call(selected), selected

    exhausted: list[str] = []

    # A chosen chat model must not silently change after a rate limit.
    model = llm_model(model)
    candidates = [model] if selected_model() else candidate_models(model, fallbacks)
    for candidate in candidates:
        for attempt in range(1, ATTEMPTS_PER_MODEL + 1):
            try:
                result = call(candidate)
            except Exception as exc:  # noqa: BLE001 - filtered to 429s below
                text = str(exc)
                if not is_rate_limit(text):
                    raise
                wait = retry_after_seconds(text)

                if is_daily_limit(text):
                    exhausted.append(f"{candidate}: daily limit reached{_describe_wait(wait)}")
                    logger.warning("[%s] Groq daily limit reached for %s.", agent, candidate)
                    break
                if attempt == ATTEMPTS_PER_MODEL or (wait is not None and wait > MAX_WAIT_SECONDS):
                    exhausted.append(f"{candidate}: rate-limited{_describe_wait(wait)}")
                    logger.warning("[%s] Groq still rate-limiting %s after %d attempt(s).", agent, candidate, attempt)
                    break

                pause = (wait + 0.5) if wait is not None else 2.0 * attempt
                logger.info("[%s] Groq per-minute limit on %s; waiting %.1fs (attempt %d/%d).",
                            agent, candidate, pause, attempt, ATTEMPTS_PER_MODEL)
                time.sleep(pause)
                continue

            if candidate != model:
                logger.warning("[%s] Answered by fallback model %s (requested %s was rate-limited).",
                               agent, candidate, model)
            return result, candidate

    raise GroqQuotaExhausted(
        ("Groq's usage limit is reached for the selected model (" if selected_model()
         else "Groq's usage limit is reached for every available model (")
        + "; ".join(exhausted)
        + "). Try again later, or pick a different model in the chat's model picker."
    )
