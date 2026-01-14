"""
Text embedding adapter for 768-dim vector embeddings.
"""

from __future__ import annotations

from typing import List, Optional

import numpy as np


class TextEmbedder:
    def __init__(self, model_name: str = "BAAI/bge-base-en-v1.5", device: Optional[str] = None) -> None:
        try:
            from sentence_transformers import SentenceTransformer  # type: ignore
        except ImportError as exc:
            raise RuntimeError(
                "Missing dependency: sentence-transformers (install before embedding)."
            ) from exc

        resolved_device = device or _resolve_device()
        self.model_name = model_name
        self.device = resolved_device
        self.model = SentenceTransformer(model_name, device=resolved_device)

    def embed_batch(self, texts: List[str]) -> np.ndarray:
        embeddings = self.model.encode(
            texts,
            convert_to_numpy=True,
            normalize_embeddings=True,
        )
        return np.asarray(embeddings, dtype=np.float32)

    def embed_query(self, text: str) -> np.ndarray:
        embeddings = self.embed_batch([text])
        return embeddings[0]


def _resolve_device() -> str:
    try:
        import torch  # type: ignore
    except Exception:
        return "cpu"
    return "cuda" if torch.cuda.is_available() else "cpu"
