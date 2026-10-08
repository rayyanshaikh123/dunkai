"""
CircuitMind Component Agent
Configuration
"""

import os

# ── Guard against fork-related segfaults on macOS / Apple Silicon ──
# Must be set before torch, tokenizers, or faiss are imported.
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("OBJC_DISABLE_INITIALIZE_FORK_SAFETY", "YES")
os.environ.setdefault("OMP_NUM_THREADS", "1")

import requests
import pandas as pd
import faiss
import torch
from dotenv import load_dotenv
from huggingface_hub import hf_hub_url
load_dotenv() 
# =============================================================================
# Hugging Face Hub
# =============================================================================

HF_REPO_ID = "rayyanshk/dunkai"
HF_REPO_TYPE = "dataset"

# Private repo -> needs a token with read access.
# Set as an environment variable, never hardcode:
#   export HF_TOKEN="hf_xxxxxxxxxxxx"
HF_TOKEN = os.environ.get("HF_TOKEN_READ")

_HEADERS = {"Authorization": f"Bearer {HF_TOKEN}"} if HF_TOKEN else {}

from pathlib import Path

CACHE_DIR = Path(os.environ.get("DUNKAI_CACHE_DIR", Path.home() / ".cache" / "dunkai"))
CACHE_DIR.mkdir(parents=True, exist_ok=True)

def _get_file_path(filename: str) -> Path:
    """Get path to cached file, downloading from HF on first startup if missing."""
    file_path = CACHE_DIR / filename
    if not file_path.exists():
        print(f"[FAISS Cache] Downloading prebuilt {filename} from Hugging Face...")
        # The desktop runtime downloads through its authenticated loopback
        # proxy. The original engine and catalogue stay unchanged; the operator
        # Hugging Face token remains on the hosted backend.
        dataset_base = os.environ.get("DUNKAI_DATASET_BASE_URL", "").rstrip("/")
        url = (dataset_base + "/" + filename) if dataset_base else hf_hub_url(repo_id=HF_REPO_ID, filename=filename, repo_type=HF_REPO_TYPE)
        resp = requests.get(url, headers={} if dataset_base else _HEADERS, stream=True, timeout=(15, 300))
        resp.raise_for_status()
        temp_path = file_path.with_suffix(file_path.suffix + ".tmp")
        with open(temp_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
        temp_path.replace(file_path)
        print(f"[FAISS Cache] Cached {filename} to {file_path}")
    else:
        print(f"[FAISS Cache] Loaded prebuilt {filename} from local cache ({file_path})")
    return file_path

# =============================================================================
# Dataset & Vector Index (Loaded from local disk cache)
# =============================================================================

_parquet_path = _get_file_path("components_ml.parquet")
DATASET_DF = pd.read_parquet(_parquet_path)

_index_path = _get_file_path("component_faiss.index")
FAISS_INDEX = faiss.read_index(str(_index_path))
# The FAISS index already contains every catalogue vector. Retrieval searches
# that index directly; loading component_embeddings.npy kept a second ~719 MiB
# copy in RAM and downloaded an unused file. Read the dimension from the index.

# =============================================================================
# Embedding Model
# =============================================================================

MODEL_NAME = "BAAI/bge-small-en-v1.5"

DEVICE = os.environ.get("DUNKAI_EMBEDDING_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")

# =============================================================================
# Retrieval
# =============================================================================

TOP_K = 20

SIMILARITY_THRESHOLD = 0.70

BATCH_SIZE = 256

# =============================================================================
# Output
# =============================================================================

DEFAULT_QTY = 1

# =============================================================================
# Supported JSON Section
# =============================================================================

ARCHITECTURE_SECTION = "architecture_model"

# =============================================================================
# Logging
# =============================================================================

VERBOSE = True

# =============================================================================
# Gradio
# =============================================================================

APP_TITLE = "CircuitMind Component Agent"

APP_DESCRIPTION = """
AI-powered Electronic Component Selection Engine

Input:
Architecture Agent JSON

Output:
Bill of Materials (BOM)
"""

# =============================================================================

if VERBOSE:

    print("=" * 60)
    print("CircuitMind Component Agent")
    print("=" * 60)

    print(f"HF Repo: {HF_REPO_ID} (local disk cache)")

    print(f"\nDataset rows: {len(DATASET_DF)}")

    print(f"\nVector dimensions: {FAISS_INDEX.d}")

    print(f"\nFAISS vectors: {FAISS_INDEX.ntotal}")

    print("\nModel")
    print(MODEL_NAME)

    print("\nDevice")
    print(DEVICE)

    print("=" * 60)
