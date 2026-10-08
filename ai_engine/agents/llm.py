"""Shared model transport; agent prompts, graph and catalogue remain unchanged."""
from langchain_groq import ChatGroq
try:
    from .credentials import OPENAI_MODELS
except ImportError:
    from credentials import OPENAI_MODELS


def create_chat_model(*, model, api_key, **options):
    if model in OPENAI_MODELS:
        from langchain_openai import ChatOpenAI
        # The model names accepted here support temperature and JSON output.
        return ChatOpenAI(model=model, api_key=api_key, **options)
    return ChatGroq(model=model, groq_api_key=api_key, **options)
