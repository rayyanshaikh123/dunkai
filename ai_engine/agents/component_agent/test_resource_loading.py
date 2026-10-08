"""Exercise the real catalogue loader/search without downloading model weights.

Run from the repository root:
  ai_engine/venv/bin/python -m unittest discover -s ai_engine/agents/component_agent -p test_resource_loading.py
"""
import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import faiss
import numpy as np
import pandas as pd


HERE = Path(__file__).resolve().parent


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ResourceLoadingTests(unittest.TestCase):
    def test_search_and_prices_work_without_standalone_embedding_file(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            pd.DataFrame([
                {"mfr_part": "PART-A", "category": "", "subcategory": "",
                 "price_qty_1": 0.25, "extra_params": '{"number":"C1"}'},
                {"mfr_part": "PART-B", "category": "", "subcategory": "",
                 "price_qty_1": 0.75, "extra_params": '{"number":"C2"}'},
            ]).to_parquet(cache / "components_ml.parquet")
            index = faiss.IndexFlatIP(2)
            index.add(np.array([[1, 0], [0, 1]], dtype=np.float32))
            faiss.write_index(index, str(cache / "component_faiss.index"))
            # Deliberately absent: the old loader would attempt a download.
            self.assertFalse((cache / "component_embeddings.npy").exists())
            torch_stub = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False))
            with patch.dict(os.environ, {"DUNKAI_CACHE_DIR": directory}), \
                    patch.dict(sys.modules, {"torch": torch_stub}), \
                    patch("dotenv.load_dotenv"), \
                    patch("requests.get", side_effect=AssertionError("Unexpected download")):
                config = load_module("resource_config", "config.py")
            # Stub only model weight loading. Search and candidate extraction use
            # the actual FAISS index, dataframe and original retriever methods.
            model = types.SimpleNamespace(encode=lambda *args, **kwargs: np.array([1, 0], dtype=np.float32))
            sentence_stub = types.SimpleNamespace(SentenceTransformer=lambda *args, **kwargs: model)
            with patch.dict(sys.modules, {"config": config, "sentence_transformers": sentence_stub}), \
                    patch.object(sys, "path", [str(HERE), *sys.path]):
                retrieval = load_module("resource_retrieval", "retrieval.py")
                retriever = retrieval.ComponentRetriever()
            scores, indices = retriever._search_index(np.array([[1, 0]], dtype=np.float32), top_k=2)
            candidates = retriever._get_candidates(indices, scores)
            self.assertEqual([item["mfr_part"] for item in candidates], ["PART-A", "PART-B"])
            self.assertEqual([item["price_qty_1"] for item in candidates], [0.25, 0.75])
            self.assertEqual(candidates[0]["extra_params"], {"number": "C1"})
            np.testing.assert_array_equal(scores, [1, 0])
            self.assertEqual(retriever.category_embeddings.shape, (0, index.d))


if __name__ == "__main__":
    unittest.main()
