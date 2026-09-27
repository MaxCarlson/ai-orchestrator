"""Hybrid code search against code_chunks."""

from __future__ import annotations

from typing import Any, Dict, List

import asyncpg
import numpy as np

from memory.pgvector_utils import to_pgvector_literal


def _rrf_merge_code_results(
    dense_results: list[dict[str, Any]],
    lexical_results: list[dict[str, Any]],
    *,
    k: int = 60,
) -> list[dict[str, Any]]:
    """Merge dense and lexical code results with reciprocal rank fusion."""
    dense_ranks = {row["id"]: rank for rank, row in enumerate(dense_results, start=1)}
    lexical_ranks = {row["id"]: rank for rank, row in enumerate(lexical_results, start=1)}
    by_id = {row["id"]: dict(row) for row in dense_results}
    for row in lexical_results:
        by_id.setdefault(row["id"], dict(row))

    merged: list[dict[str, Any]] = []
    for row_id, row in by_id.items():
        score = 0.0
        if row_id in dense_ranks:
            score += 1.0 / (k + dense_ranks[row_id])
        if row_id in lexical_ranks:
            score += 1.0 / (k + lexical_ranks[row_id])
        row["rrf_score"] = score
        row.setdefault("similarity", 0.0)
        row.setdefault("lexical_score", 0.0)
        merged.append(row)

    merged.sort(key=lambda row: row["rrf_score"], reverse=True)
    return merged


async def dense_code_search(
    conn: asyncpg.Connection,
    project_id: str,
    query_embedding: np.ndarray,
    top_k: int = 30,
) -> list[dict[str, Any]]:
    rows = await conn.fetch(
        """
        SELECT
            id,
            file_path,
            symbol_name,
            chunk_type,
            start_line,
            end_line,
            content,
            1 - (embedding <=> $1) AS similarity,
            0.0::double precision AS lexical_score
        FROM code_chunks
        WHERE project_id = $2 AND embedding_status = 'ready'
        ORDER BY embedding <=> $1
        LIMIT $3
        """,
        to_pgvector_literal(query_embedding),
        project_id,
        top_k,
    )
    return [dict(row) for row in rows]


async def lexical_code_search(
    conn: asyncpg.Connection,
    project_id: str,
    query: str,
    top_k: int = 30,
) -> list[dict[str, Any]]:
    rows = await conn.fetch(
        """
        WITH query AS (
            SELECT websearch_to_tsquery('simple', $2) AS q
        )
        SELECT
            c.id,
            c.file_path,
            c.symbol_name,
            c.chunk_type,
            c.start_line,
            c.end_line,
            c.content,
            0.0::double precision AS similarity,
            ts_rank_cd(c.search_vector, query.q) AS lexical_score
        FROM code_chunks c, query
        WHERE c.project_id = $1
          AND c.embedding_status = 'ready'
          AND c.search_vector @@ query.q
        ORDER BY lexical_score DESC, c.file_path ASC, c.symbol_name ASC
        LIMIT $3
        """,
        project_id,
        query,
        top_k,
    )
    return [dict(row) for row in rows]


async def search_code(
    conn: asyncpg.Connection,
    project_id: str,
    query: str,
    query_embedding: np.ndarray,
    top_k: int = 20,
) -> List[Dict[str, Any]]:
    candidate_k = max(top_k * 3, 30)
    dense = await dense_code_search(conn, project_id, query_embedding, top_k=candidate_k)
    lexical = await lexical_code_search(conn, project_id, query, top_k=candidate_k)
    merged = _rrf_merge_code_results(dense, lexical)
    return merged[:top_k]
