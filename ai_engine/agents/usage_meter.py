"""Per-request Groq usage collection without retaining prompts or API keys."""

from contextlib import contextmanager
from contextvars import ContextVar

from langchain_core.callbacks import BaseCallbackHandler

_active_usage: ContextVar[list[dict] | None] = ContextVar("active_groq_usage", default=None)


class _UsageCallback(BaseCallbackHandler):
    def on_llm_end(self, response, **kwargs):
        rows = _active_usage.get()
        if rows is None:
            return
        output = response.llm_output or {}
        generation = (response.generations or [[]])[0]
        message = generation[0].message if generation and hasattr(generation[0], "message") else None
        metadata = (getattr(message, "response_metadata", None) or {}) if message else {}
        usage = output.get("token_usage") or metadata.get("token_usage") or getattr(message, "usage_metadata", None) or {}
        if not usage:
            rows.append({"model": output.get("model_name") or metadata.get("model_name"), "unmetered": True})
            return
        input_tokens = usage.get("prompt_tokens", usage.get("input_tokens", 0))
        output_tokens = usage.get("completion_tokens", usage.get("output_tokens", 0))
        details = usage.get("prompt_tokens_details") or usage.get("input_token_details") or {}
        rows.append({
            "model": output.get("model_name") or metadata.get("model_name"),
            "inputTokens": int(input_tokens or 0),
            "outputTokens": int(output_tokens or 0),
            "cachedInputTokens": int(details.get("cached_tokens", details.get("cache_read", 0)) or 0),
        })


USAGE_CALLBACK = _UsageCallback()


@contextmanager
def capture_usage():
    rows = []
    token = _active_usage.set(rows)
    try:
        yield rows
    finally:
        _active_usage.reset(token)


def record_external_usage(model, usage):
    rows = _active_usage.get()
    if rows is None or not isinstance(usage, dict):
        return
    details = usage.get("prompt_tokens_details") or {}
    rows.append({
        "model": model,
        "inputTokens": int(usage.get("prompt_tokens", usage.get("input_tokens", 0)) or 0),
        "outputTokens": int(usage.get("completion_tokens", usage.get("output_tokens", 0)) or 0),
        "cachedInputTokens": int(details.get("cached_tokens", 0) or 0),
    })
