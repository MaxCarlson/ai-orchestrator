"""
Embedding model registry for the AI Orchestrator memory system.

Provides functions for registering embedding models, retrieving the
default model for a given purpose, and validating that a model's
actual output dimensions match what the database schema expects.

This module is the authoritative source of truth for which models
are used for text, code, and reranking purposes. Models are stored
in the ``embedding_models`` table so that the schema and the
embedding code stay in sync.
"""

from __future__ import annotations

import logging
from typing import Optional

import asyncpg


logger = logging.getLogger(__name__)


async def register_model(
    conn: asyncpg.Connection,
    *,
    model_id: str,
    purpose: str,
    dimensions: int,
    framework: str = "sentence-transformers",
    is_default: bool = False,
) -> None:
    """Register or update an embedding model in the registry.

    Args:
        conn: An acquired asyncpg connection.
        model_id: HuggingFace model ID, e.g. 'BAAI/bge-base-en-v1.5'.
        purpose: One of 'text', 'code', or 'rerank'.
        dimensions: Output vector dimension (0 for rerankers).
        framework: Model framework name.
        is_default: Whether this is the default model for its purpose.
    """
    if is_default:
        await conn.execute(
            """
            UPDATE embedding_models SET is_default = FALSE
            WHERE purpose = $1
            """,
            purpose,
        )
    await conn.execute(
        """
        INSERT INTO embedding_models (id, purpose, dimensions, framework, is_default)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE
            SET purpose     = EXCLUDED.purpose,
                dimensions  = EXCLUDED.dimensions,
                framework   = EXCLUDED.framework,
                is_default  = EXCLUDED.is_default
        """,
        model_id,
        purpose,
        dimensions,
        framework,
        is_default,
    )
    logger.info("Registered embedding model %s (purpose=%s, dims=%d)", model_id, purpose, dimensions)


async def get_model(
    conn: asyncpg.Connection,
    purpose: str,
    model_id: Optional[str] = None,
) -> dict:
    """Retrieve model metadata for the given purpose.

    Args:
        conn: An acquired asyncpg connection.
        purpose: One of 'text', 'code', or 'rerank'.
        model_id: If provided, fetch this specific model instead of the
            default for the purpose.

    Returns:
        A dict with keys: id, purpose, dimensions, framework, is_default.

    Raises:
        ValueError: If no matching model is found.
    """
    if model_id is not None:
        row = await conn.fetchrow(
            "SELECT id, purpose, dimensions, framework, is_default FROM embedding_models WHERE id = $1",
            model_id,
        )
        if row is None:
            raise ValueError(f"Embedding model not found in registry: {model_id!r}")
    else:
        row = await conn.fetchrow(
            """
            SELECT id, purpose, dimensions, framework, is_default
            FROM embedding_models
            WHERE purpose = $1 AND is_default = TRUE
            LIMIT 1
            """,
            purpose,
        )
        if row is None:
            raise ValueError(f"No default embedding model registered for purpose {purpose!r}")
    return dict(row)


async def validate_dimensions(
    conn: asyncpg.Connection,
    model_id: str,
    actual_dims: int,
) -> None:
    """Validate that a model's actual output dimensions match the registry.

    Args:
        conn: An acquired asyncpg connection.
        model_id: The model to validate.
        actual_dims: The dimension count produced by the loaded model.

    Raises:
        ValueError: If the dimensions do not match.
    """
    row = await conn.fetchrow(
        "SELECT dimensions FROM embedding_models WHERE id = $1",
        model_id,
    )
    if row is None:
        raise ValueError(f"Model {model_id!r} not found in registry; register it first")
    expected = row["dimensions"]
    if expected != actual_dims:
        raise ValueError(
            f"Dimension mismatch for model {model_id!r}: "
            f"registry expects {expected}, model produced {actual_dims}"
        )
    logger.debug("Dimension check passed for %s: %d dims", model_id, actual_dims)
