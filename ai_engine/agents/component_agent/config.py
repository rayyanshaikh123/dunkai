"""
CircuitMind Component Agent
Configuration
"""

import os
import io
import requests
import numpy as np
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
        url = hf_hub_url(repo_id=HF_REPO_ID, filename=filename, repo_type=HF_REPO_TYPE)
        resp = requests.get(url, headers=_HEADERS, stream=True)
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

_embeddings_path = _get_file_path("component_embeddings.npy")
EMBEDDINGS = np.load(_embeddings_path)

_index_path = _get_file_path("component_faiss.index")
FAISS_INDEX = faiss.read_index(str(_index_path))

# =============================================================================
# Embedding Model
# =============================================================================

MODEL_NAME = "BAAI/bge-small-en-v1.5"

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

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

    print(f"HF Repo: {HF_REPO_ID} (in-memory, no local cache)")

    print(f"\nDataset rows: {len(DATASET_DF)}")

    print(f"\nEmbeddings shape: {EMBEDDINGS.shape}")

    print(f"\nFAISS vectors: {FAISS_INDEX.ntotal}")

    print("\nModel")
    print(MODEL_NAME)

    print("\nDevice")
    print(DEVICE)

    print("=" * 60)