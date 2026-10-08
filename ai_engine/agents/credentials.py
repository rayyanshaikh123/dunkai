"""Per-request provider credentials (BYOK).

A user who brings their own key must have *their* key used for *their* run and
nobody else's. Writing it into ``os.environ`` would do the opposite: the
supervisor serves concurrent requests from one process, so a key set for one
run would be read by every other run in flight.

The key therefore lives in a :class:`~contextvars.ContextVar`. LangGraph and
LangChain copy the current context into the worker threads they spawn, so a
value set at the top of a request is visible to every node of that request and
to no other request.

Lookup order for every provider: the request's own key, then the operator's
environment variable (the hosted "platform" key), then nothing.
"""

from __future__ import annotations

import os
import sys
import types
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator, Mapping

#: provider name -> environment variable holding the operator's key.
ENV_VARS: dict[str, str] = {
    "openai": "OPENAI_API_KEY",
    "groq": "GROQ_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "ollama": "OLLAMA_API_KEY",
}


def _shared_context_var() -> ContextVar[Mapping[str, str]]:
    """One ContextVar per process, however this module was imported.

    This module is loaded under two names: ``agents.credentials`` by the
    supervisor package (server.py, board.py) and plain ``credentials`` by the
    agents, which nodes.py imports as top-level modules. Each name runs this
    file again, and two ContextVars would mean the server sets the user's key
    on one while the agents read the other -- every BYOK run silently billed
    to the operator. Parking the var in ``sys.modules`` makes both share it.
    """
    holder = sys.modules.get("_dunkai_credentials_state")
    if holder is None:
        holder = types.ModuleType("_dunkai_credentials_state")
        holder.request_keys = ContextVar("dunkai_request_keys", default={})
        holder.request_model = ContextVar("dunkai_request_model", default=None)
        sys.modules["_dunkai_credentials_state"] = holder
    return holder.request_keys


_request_keys = _shared_context_var()
_request_model = sys.modules["_dunkai_credentials_state"].request_model
OPENAI_MODELS = ("gpt-4.1", "gpt-4.1-mini")


def _clean(credentials: Mapping[str, object] | None) -> dict[str, str]:
    if not credentials:
        return {}
    return {
        name: value.strip()
        for name, value in credentials.items()
        if name in ENV_VARS and isinstance(value, str) and value.strip()
    }


@contextmanager
def use_credentials(credentials: Mapping[str, object] | None, *, model: str | None = None) -> Iterator[None]:
    """Make ``credentials`` the active keys for the duration of the block."""
    token = _request_keys.set(_clean(credentials))
    model_token = _request_model.set(model)
    try:
        yield
    finally:
        _request_model.reset(model_token)
        _request_keys.reset(token)


def llm_provider() -> str:
    return "openai" if _request_model.get() in OPENAI_MODELS else "groq"


def llm_model(model: str | None = None) -> str:
    if llm_provider() == "openai":
        return model if model in OPENAI_MODELS else _request_model.get()
    return model or os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")


def llm_api_key() -> str:
    provider = llm_provider()
    key = api_key(provider)
    if not key: raise EnvironmentError(f"Add your {provider.title()} API key in Settings before using this model.")
    return key


def api_key(provider: str) -> str | None:
    """The key to use for ``provider`` right now: the user's, else the operator's."""
    own = _request_keys.get().get(provider)
    if own:
        return own
    env_var = ENV_VARS.get(provider)
    return os.getenv(env_var) if env_var else None


def is_user_key(provider: str) -> bool:
    """True when the active key for ``provider`` came from the request."""
    return bool(_request_keys.get().get(provider))


def subprocess_env(base: Mapping[str, str] | None = None) -> dict[str, str]:
    """An environment for a child process with the request's keys applied.

    The child gets a copy; this process's own environment is never touched.
    """
    env = dict(base if base is not None else os.environ)
    for provider, key in _request_keys.get().items():
        env[ENV_VARS[provider]] = key
    return env


def groq_api_key() -> str:
    """The Groq key for the current request, or a clear error naming both sources."""
    key = api_key("groq")
    if not key:
        raise EnvironmentError(
            "No Groq API key: add one in Settings → API keys, or set GROQ_API_KEY on the AI engine."
        )
    return key
