"""
High‑level memory manager for the AI Orchestrator.

This module exposes a :class:`MemoryManager` which encapsulates all
operations on the hierarchical memory. It coordinates with the
underlying vector store to perform semantic search and handles
creation of memory items, category tagging, feedback updates and
retention policies. The manager works with the existing asyncpg
connection pool used by the orchestrator.

Basic usage:

.. code-block:: python

    from memory.manager import MemoryManager, initialize_schema
    from orchestrator.main import get_db_pool

    async def bootstrap():
        pool = await get_db_pool()
        async with pool.acquire() as conn:
            # Create tables if they do not exist
            await initialize_schema(conn)

    async def store_example():
        pool = await get_db_pool()
        async with pool.acquire() as conn:
            mgr = MemoryManager()
            emb = your_embedding_generator("Example text")
            await mgr.add_memory(
                conn,
                content="Example text",
                embedding=emb,
                project_id=project_uuid,
                created_by="orchestrator",
                categories=["example"],
            )

    async def query_example():
        pool = await get_db_pool()
        async with pool.acquire() as conn:
            mgr = MemoryManager()
            query_emb = your_embedding_generator("What is example text?")
            results = await mgr.search(
                conn,
                embedding=query_emb,
                project_id=project_uuid,
                top_k=3,
            )
            print(results)

See the hierarchical memory specification for more details on how
memories are organised and retained. This manager does not yet
implement retention policies or quota enforcement; those features can
be layered on top by periodically evaluating access counts and
timestamps.
"""

from __future__ import annotations

import logging
from typing import List, Optional, Sequence, Tuple

import asyncpg
import numpy as np

from . import models
from .vector_store import PgVectorStore, VectorStore


logger = logging.getLogger(__name__)


async def initialize_schema(conn: asyncpg.Connection) -> None:
    """Create memory tables and indexes if they do not already exist.

    This function executes the SQL statements defined in
    :mod:`memory.models` to set up the required schema. It should be
    called during application startup or via a migration. It is safe
    to run multiple times.
    """
    # Enable pgcrypto extension for gen_random_uuid and pgvector for
    # embedding type. These statements are idempotent.
    await conn.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto;")
    await conn.execute("CREATE EXTENSION IF NOT EXISTS vector;")
    # Create tables
    await conn.execute(models.CREATE_SYSTEM_TABLE)
    await conn.execute(models.CREATE_MEMORY_TABLE)
    await conn.execute(models.CREATE_CATEGORY_TABLE)
    await conn.execute(models.CREATE_MEMORY_CATEGORY_TABLE)
    await conn.execute(models.CREATE_CODE_CHUNKS_TABLE)
    await conn.execute(models.ALTER_MEMORY_EMBEDDING_DIMENSION)
    await conn.execute(models.UPSERT_DEFAULT_SYSTEM)
    # Create embedding index
    await conn.execute(models.CREATE_EMBEDDING_INDEX)
    await conn.execute(models.CREATE_CODE_CHUNKS_INDEXES)


class MemoryManager:
    """Manager for interacting with the hierarchical memory system.

    The manager uses a :class:`VectorStore` to perform similarity
    searches. By default it uses :class:`PgVectorStore`, but a
    different implementation can be provided by passing a ``store``
    argument at construction time. Most methods expect an
    ``asyncpg.Connection``; you can obtain one from the orchestrator's
    connection pool via ``get_db_pool``.
    """

    def __init__(self, store: Optional[VectorStore] = None) -> None:
        self.store = store or PgVectorStore()

    async def add_memory(
        self,
        conn: asyncpg.Connection,
        *,
        content: str,
        embedding: np.ndarray,
        project_id: Optional[str] = None,
        task_id: Optional[str] = None,
        system_id: Optional[str] = None,
        created_by: str,
        categories: Optional[Sequence[str]] = None,
    ) -> str:
        """Insert a new memory item and return its generated ID.

        :param conn: An acquired asyncpg connection.
        :param content: The textual or code content of the memory.
        :param embedding: A numpy array containing the vector
            representation. Must be convertible to float32.
        :param project_id: Optional UUID of the project this memory
            belongs to.
        :param task_id: Optional UUID of the task this memory belongs to.
        :param system_id: Optional UUID of the system this memory
            belongs to.
        :param created_by: Identifier of the creator (user or
            orchestrator).
        :param categories: Optional list of category names to tag this
            memory with. Categories will be created if they do not
            exist.
        :returns: The memory_id of the inserted record.
        """
        # Ensure embedding is float32; asyncpg automatically casts a
        # Python list to the pgvector ``vector`` type.
        emb = np.asarray(embedding, dtype=np.float32)
        async with conn.transaction():
            # Insert memory item and retrieve its ID
            record = await conn.fetchrow(
                """
                INSERT INTO memory_items (
                    content, embedding, project_id, task_id, system_id,
                    created_by
                ) VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING memory_id
                """,
                content,
                emb,
                project_id,
                task_id,
                system_id,
                created_by,
            )
            memory_id: str = record["memory_id"]
            # Upsert categories and link to memory
            if categories:
                for name in categories:
                    cat = await conn.fetchrow(
                        """
                        INSERT INTO categories (name)
                        VALUES ($1)
                        ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
                        RETURNING category_id
                        """,
                        name,
                    )
                    category_id: str = cat["category_id"]
                    await conn.execute(
                        """
                        INSERT INTO memory_categories (memory_id, category_id)
                        VALUES ($1, $2)
                        ON CONFLICT (memory_id, category_id) DO NOTHING
                        """,
                        memory_id,
                        category_id,
                    )
            return memory_id

    async def search(
        self,
        conn: asyncpg.Connection,
        *,
        embedding: np.ndarray,
        project_id: Optional[str] = None,
        system_id: Optional[str] = None,
        task_id: Optional[str] = None,
        categories: Optional[Sequence[str]] = None,
        top_k: int = 5,
    ) -> List[Tuple[str, float]]:
        """Perform a similarity search for a given embedding.

        The search can be filtered by project, system, task and/or
        categories. The return value is a list of tuples
        ``(memory_id, similarity)``, sorted by descending similarity.

        :param conn: An asyncpg connection.
        :param embedding: Query vector as a numpy array.
        :param project_id: Restrict search to this project (optional).
        :param system_id: Restrict search to this system (optional).
        :param task_id: Restrict search to this task (optional).
        :param categories: Restrict search to memories with these
            categories (optional). If multiple categories are provided,
            memories must match *all* specified categories.
        :param top_k: Maximum number of results to return.
        :returns: List of (memory_id, similarity) tuples.
        """
        filters = []
        params: List[str] = []
        if project_id:
            filters.append(f"project_id = '{project_id}'")
        if system_id:
            filters.append(f"system_id = '{system_id}'")
        if task_id:
            filters.append(f"task_id = '{task_id}'")
        if categories:
            # Join on memory_categories/categories to ensure all
            # specified category names are associated with the memory
            # item. We build a subquery that selects memory_ids with
            # all category matches.
            category_filter = (
                """
                memory_id IN (
                    SELECT mc.memory_id
                    FROM memory_categories mc
                    JOIN categories c ON c.category_id = mc.category_id
                    WHERE c.name = ANY($2::text[])
                    GROUP BY mc.memory_id
                    HAVING COUNT(*) = $3
                )
                """
            )
            filters.append(category_filter)
        filter_sql = " AND ".join(filters) if filters else None
        results = await self.store.query(
            conn=conn,
            table="memory_items",
            vector=np.asarray(embedding, dtype=np.float32),
            filters=filter_sql,
            top_k=top_k,
        )
        # Update access counters and timestamps asynchronously
        for memory_id, _similarity in results:
            await conn.execute(
                """
                UPDATE memory_items
                SET access_count = access_count + 1,
                    last_accessed_at = NOW()
                WHERE memory_id = $1
                """,
                memory_id,
            )
        return results

    async def update_feedback(
        self,
        conn: asyncpg.Connection,
        memory_id: str,
        feedback: int,
    ) -> None:
        """Update the user feedback score for a memory item.

        A positive value indicates good/valuable memory; negative
        indicates bad/irrelevant memory. Zero clears feedback. The
        retention policy (implemented separately) should take this
        feedback into account when deciding whether to keep or evict
        memories.
        """
        await conn.execute(
            """
            UPDATE memory_items
            SET user_feedback = $2
            WHERE memory_id = $1
            """,
            memory_id,
            feedback,
        )
