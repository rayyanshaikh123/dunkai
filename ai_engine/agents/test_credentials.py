"""Tests for credentials: per-request BYOK keys reach the agents, and only them.

    python ai_engine/agents/test_credentials.py

No network. Each check pins one property that BYOK silently depends on: if
any of them broke, a user's run would quietly bill the operator's key, or
worse, another user's.
"""

from __future__ import annotations

import importlib
import os
import sys
import threading
from pathlib import Path

AGENTS = Path(__file__).resolve().parent
sys.path.insert(0, str(AGENTS))
sys.path.insert(0, str(AGENTS.parent))

import credentials  # noqa: E402  -- the name the agents use
from credentials import api_key, is_user_key, subprocess_env, use_credentials  # noqa: E402

failures = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failures
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  -- ' + detail if detail else ''}")
    if not ok:
        failures += 1


os.environ["GROQ_API_KEY"] = "platform-key"

# ---- lookup order ---------------------------------------------------------------
check("no request key -> operator key", api_key("groq") == "platform-key")
with use_credentials({"groq": "  user-key  "}):
    check("request key wins, trimmed", api_key("groq") == "user-key")
    check("is_user_key reports the source", is_user_key("groq") and not is_user_key("gemini"))
check("key is gone after the block", api_key("groq") == "platform-key")

with use_credentials({"groq": "", "unknown": "x", "gemini": 5}):  # type: ignore[dict-item]
    check("blank, unknown and non-string entries are ignored",
          api_key("groq") == "platform-key" and api_key("unknown") is None and not is_user_key("gemini"))

with use_credentials({"openai": "gpt-user-key"}, model="gpt-4.1"):
    check("GPT uses its request key and model", credentials.llm_api_key() == "gpt-user-key" and credentials.llm_model() == "gpt-4.1")
    check("GPT key reaches only its designer child", subprocess_env().get("OPENAI_API_KEY") == "gpt-user-key" and os.getenv("OPENAI_API_KEY") is None)
check("GPT provider context resets", credentials.llm_provider() == "groq" and api_key("openai") is None)

with use_credentials({"groq": "groq-user-key"}, model="openai/gpt-oss-20b"):
    check("selected Groq model overrides every agent default",
          credentials.llm_model("openai/gpt-oss-safeguard-20b") == "openai/gpt-oss-20b")
with use_credentials({"openai": "gpt-user-key"}, model="gpt-4.1-mini"):
    check("selected GPT mini overrides GPT-4.1 defaults", credentials.llm_model("gpt-4.1") == "gpt-4.1-mini")

# ---- both import names share one ContextVar -------------------------------------
# server.py/board.py import `agents.credentials`; the agents import `credentials`.
pkg_credentials = importlib.import_module("agents.credentials")
check("loaded under two names", pkg_credentials is not credentials)
with pkg_credentials.use_credentials({"groq": "set-via-package"}):
    check("a key set via agents.credentials is seen via credentials",
          credentials.api_key("groq") == "set-via-package")

# ---- concurrent requests do not see each other's keys ---------------------------
seen: dict[str, str | None] = {}
barrier = threading.Barrier(2)


def request(user: str) -> None:
    with use_credentials({"groq": f"key-of-{user}"}):
        barrier.wait()  # both requests hold a key at the same moment
        seen[user] = api_key("groq")


threads = [threading.Thread(target=request, args=(u,)) for u in ("alice", "bob")]
for t in threads:
    t.start()
for t in threads:
    t.join()
check("concurrent requests are isolated", seen == {"alice": "key-of-alice", "bob": "key-of-bob"}, str(seen))

# ---- subprocess env is a copy -------------------------------------------------------
with use_credentials({"gemini": "user-gemini"}):
    child = subprocess_env()
check("child env carries the user's key", child.get("GEMINI_API_KEY") == "user-gemini")
check("this process's env is untouched", os.environ.get("GEMINI_API_KEY") != "user-gemini")

# ---- the key reaches LangGraph nodes, behind the keepalive pump thread -----------
# This is the real streaming path: _stream_generator sets the key, and
# _with_keepalive drains it on a separate thread while LangGraph runs nodes.
try:
    from typing import TypedDict

    from langgraph.graph import END, START, StateGraph
except ImportError:
    print("SKIP  langgraph not installed; node propagation not checked")
else:
    class S(TypedDict, total=False):
        key: str

    graph = StateGraph(S)
    graph.add_node("read", lambda _s: {"key": api_key("groq")})
    graph.add_edge(START, "read")
    graph.add_edge("read", END)
    compiled = graph.compile()

    def generator():
        with use_credentials({"groq": "streamed-user-key"}):
            for chunk in compiled.stream({}):
                yield chunk

    results: list = []
    pump = threading.Thread(target=lambda: results.extend(generator()))
    pump.start()
    pump.join()
    got = results[0]["read"]["key"] if results else None
    check("a LangGraph node sees the request's key", got == "streamed-user-key", repr(got))

print(f"\n{failures} FAILED" if failures else "\nall checks passed")
sys.exit(1 if failures else 0)
