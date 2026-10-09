"""Tests for groq_limits: wait parsing, daily-vs-minute handling, model fallback.

    python ai_engine/agents/test_groq_limits.py

No network: Groq is replaced by a scripted callable, and time.sleep by a
recorder, so the waits are asserted rather than slept through. The error
strings are Groq's real 429 wording.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import groq_limits  # noqa: E402
from credentials import use_credentials
from groq_limits import GroqQuotaExhausted, invoke_with_limits, retry_after_seconds  # noqa: E402

DAILY = (
    "Error code: 429 - {'error': {'message': 'Rate limit reached for model `%s` in organization `org_x` "
    "service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199089, Requested 1705. "
    "Please try again in 5m43.008s.', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}"
)
MINUTE = (
    "Error code: 429 - {'error': {'message': 'Rate limit reached for model `%s` in organization `org_x` "
    "service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 7900, Requested 1500. "
    "Please try again in 1.2s.', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}"
)

failures = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failures
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  -- ' + detail if detail else ''}")
    if not ok:
        failures += 1


slept: list[float] = []
groq_limits.time.sleep = slept.append  # record waits instead of sleeping


def scripted(outcomes: dict[str, list[str | None]]):
    """A fake Groq call: per model, a queue of error strings (None = success)."""
    calls: list[str] = []

    def call(model: str):
        calls.append(model)
        queue = outcomes.get(model, [None])
        outcome = queue.pop(0) if queue else None
        if outcome is not None:
            raise RuntimeError(outcome % model if "%s" in outcome else outcome)
        return f"answer from {model}"

    return call, calls


os.environ["GROQ_FALLBACK_MODELS"] = "openai/gpt-oss-20b,qwen/qwen3.8-27b"

# ---- parsing ----------------------------------------------------------------------
check("parses minutes+seconds", abs(retry_after_seconds(DAILY) - 343.008) < 1e-6, str(retry_after_seconds(DAILY)))
check("parses plain seconds", retry_after_seconds(MINUTE) == 1.2)
check("parses milliseconds", retry_after_seconds("Please try again in 250ms.") == 0.25)
check("parses hours", retry_after_seconds("try again in 1h2m3s") == 3723)
check("no duration -> None", retry_after_seconds("rate_limit_exceeded") is None)

# ---- the screenshot case: daily limit on the default model -> fallback -------------
slept.clear()
call, calls = scripted({"openai/gpt-oss-120b": [DAILY]})
result, used = invoke_with_limits(call, "openai/gpt-oss-120b", agent="test")
check("daily limit falls back to the next model", used == "openai/gpt-oss-20b" and result == "answer from openai/gpt-oss-20b")
check("daily limit is not retried on the same model", calls == ["openai/gpt-oss-120b", "openai/gpt-oss-20b"], str(calls))
check("daily limit does not sleep", slept == [], str(slept))

# ---- per-minute limit waits the time Groq asked for, same model -------------------
slept.clear()
call, calls = scripted({"openai/gpt-oss-120b": [MINUTE, MINUTE, None]})
result, used = invoke_with_limits(call, "openai/gpt-oss-120b", agent="test")
check("per-minute limit retries the same model", used == "openai/gpt-oss-120b" and calls.count("openai/gpt-oss-120b") == 3)
check("per-minute wait uses Groq's retry-after", slept == [1.7, 1.7], str(slept))

# ---- persistent per-minute limit eventually moves on -------------------------------
slept.clear()
call, calls = scripted({"openai/gpt-oss-120b": [MINUTE] * 10})
result, used = invoke_with_limits(call, "openai/gpt-oss-120b", agent="test")
check("persistent per-minute limit falls back after the attempt budget", used == "openai/gpt-oss-20b",
      f"{calls.count('openai/gpt-oss-120b')} attempts on 120b")

# ---- everything exhausted -> one readable error ------------------------------------
call, calls = scripted({m: [DAILY] for m in ("openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b")})
try:
    invoke_with_limits(call, "openai/gpt-oss-120b", agent="test")
    check("all models exhausted raises", False)
except GroqQuotaExhausted as exc:
    text = str(exc)
    check("all models exhausted raises GroqQuotaExhausted", True)
    check("message names each model and when it frees up",
          all(m in text for m in ("gpt-oss-120b", "gpt-oss-20b", "qwen3.8-27b")) and "~5m 43s" in text, text)
    check("message carries no raw JSON", "{'error'" not in text)

# ---- non-rate-limit errors are not swallowed or retried ----------------------------
call, calls = scripted({"openai/gpt-oss-120b": ["Error code: 400 - invalid json_schema"]})
try:
    invoke_with_limits(call, "openai/gpt-oss-120b", agent="test")
    check("other errors propagate", False)
except RuntimeError as exc:
    check("other errors propagate unchanged, first attempt, no fallback",
          "400" in str(exc) and calls == ["openai/gpt-oss-120b"], str(calls))

# ---- fallback can be switched off --------------------------------------------------
os.environ["GROQ_FALLBACK_MODELS"] = ""
call, calls = scripted({"openai/gpt-oss-120b": [DAILY]})
try:
    invoke_with_limits(call, "openai/gpt-oss-120b", agent="test")
    check("GROQ_FALLBACK_MODELS='' disables fallback", False)
except GroqQuotaExhausted:
    check("GROQ_FALLBACK_MODELS='' disables fallback", calls == ["openai/gpt-oss-120b"])

# ---- a requested model already in the fallback list is not tried twice -------------
os.environ["GROQ_FALLBACK_MODELS"] = "openai/gpt-oss-20b,qwen/qwen3.8-27b"
check("requested model is not duplicated",
      groq_limits.candidate_models("openai/gpt-oss-20b") == ["openai/gpt-oss-20b", "qwen/qwen3.8-27b"])

with use_credentials({}, model="openai/gpt-oss-20b"):
    call, calls = scripted({"openai/gpt-oss-20b": [DAILY]})
    try:
        invoke_with_limits(call, "openai/gpt-oss-120b", agent="test")
        check("explicit selection cannot silently fall back", False)
    except GroqQuotaExhausted as exc:
        check("explicit selection cannot silently fall back",
              calls == ["openai/gpt-oss-20b"] and "selected model" in str(exc), str(calls))

print(f"\n{failures} FAILED" if failures else "\nall checks passed")
sys.exit(1 if failures else 0)
