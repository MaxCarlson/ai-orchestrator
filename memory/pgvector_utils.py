from __future__ import annotations

import numpy as np


def to_pgvector_literal(vector: np.ndarray) -> str:
    """Convert a vector into pgvector's text literal format."""
    arr = np.asarray(vector, dtype=np.float32).reshape(-1)
    return "[" + ",".join(f"{float(value):.8f}" for value in arr) + "]"
