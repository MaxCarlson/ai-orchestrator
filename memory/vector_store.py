"""
Vector store abstraction for hierarchical memory.

This module defines the interface for performing similarity search on
memory embeddings and provides a concrete implementation based on
PostgreSQL's ``pgvector`` extension. Should you decide to switch to
another vector database (e.g. Qdrant, Weaviate or Milvus), you can
implement the same interface in a separate class and configure
``MemoryManager`` to use it.
"""
from __future__ import annotations

from typing import List, Optional, Sequence, Tuple

import asyncpg
import numpy as np

from .pgvector_utils import to_pgvector_literal


class VectorStore:
    """Abstract interface for a vector store.

    Concrete implementations must provide ``add_vectors`` and
    ``query`` methods. A vector store is responsible for persisting
    embeddings and performing nearest‑neighbour queries. In this
    reference implementation, embeddings are stored directly in
    Postgres; other backends can be used by implementing this class.
    """

    async def add_vectors(
        self,
        conn: asyncpg.Connection,
        table: str,
        embeddings: Sequence[np.ndarray],
        ids: Sequence[str],
    ) -> None:
        raise NotImplementedError

    async def query(
        self,
        conn: asyncpg.Connection,
        table: str,
        vector: np.ndarray,
        filters: Optional[str] = None,
        top_k: int = 5,
    ) -> List[Tuple[str, float]]:
        raise NotImplementedError


class PgVectorStore(VectorStore):
    """Vector store implementation using PostgreSQL/pgvector.

    Embeddings are stored in a single table alongside metadata. To
    perform a similarity search we rely on the ``embedding <-> :query``
    syntax provided by pgvector. The ``filters`` argument may be a SQL
    fragment such as ``project_id = $1`` to restrict results to a
    specific context. See ``memory.manager.MemoryManager.search`` for
    examples.
    """

    async def add_vectors(
        self,
        conn: asyncpg.Connection,
        table: str,
        embeddings: Sequence[np.ndarray],
        ids: Sequence[str],
    ) -> None:
        # For pgvector the embeddings are stored directly as part of
        # the memory_items table; insertion happens via SQL in
        # ``MemoryManager.add_memory``. No separate action is needed.
        return None

    async def query(
        self,
        conn: asyncpg.Connection,
        table: str,
        vector: np.ndarray,
        filters: Optional[str] = None,
        top_k: int = 5,
    ) -> List[Tuple[str, float]]:
        # Prepare the base query. The ``embedding <-> $1`` operator
        # computes the cosine distance between stored embeddings and the
        # query vector. Lower distances imply higher similarity. We
        # negate the distance when sorting so that the most similar
        # vectors appear first.
        where_clause = f"WHERE {filters}" if filters else ""
        query = f"""
            SELECT memory_id,
                   1.0 - (embedding <-> $1) AS similarity
            FROM {table}
            {where_clause}
            ORDER BY embedding <-> $1
            LIMIT {top_k}
        """
        records = await conn.fetch(query, to_pgvector_literal(vector))
        return [(r["memory_id"], r["similarity"]) for r in records]
