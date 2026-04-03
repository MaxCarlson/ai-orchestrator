"""
Unified retrieval layer for the text and code RAG pipelines.

Provides dense vector search (pgvector cosine), BM25 sparse search
(rank-bm25), Reciprocal Rank Fusion merging, and optional
cross-encoder reranking. All search paths use the same cosine distance
operator (<=> in pgvector), which supersedes the inconsistent
operators in the legacy vector_store.py and manager.py.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Awaitable, Callable

import asyncpg
import numpy as np


logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────
# BM25 in-process cache
# ─────────────────────────────────────────────────────────────
# key: (table, owner_column, owner_id)
# value: (cache_timestamp, BM25Okapi_instance, rows: list[dict])
_bm25_cache: dict[tuple[str, str, str], tuple[float, Any, list[dict]]] = {}
BM25_CACHE_TTL_SECS: float = 300.0


def invalidate_bm25_cache(owner_id: str) -> None:
    """Remove all BM25 cache entries for the given owner_id.

    Call after any write to text_chunks for a project to ensure the
    next search rebuilds the BM25 index with fresh data.

    Args:
        owner_id: Project UUID or source_key whose cache entries to drop.
    """
    keys_to_delete = [k for k in _bm25_cache if k[2] == owner_id]
    for key in keys_to_delete:
        del _bm25_cache[key]
    if keys_to_delete:
        logger.debug("Invalidated %d BM25 cache entries for owner_id=%s", len(keys_to_delete), owner_id)


async def _load_bm25(
    conn: asyncpg.Connection,
    table: str,
    owner_column: str,
    owner_id: str,
) -> tuple[Any, list[dict]]:
    """Load or return a cached BM25 index for the given owner scope.

    Fetches all ready chunks for the owner, builds a BM25Okapi index,
    and caches it with a TTL. Stale caches are rebuilt automatically.

    Args:
        conn: An asyncpg connection.
        table: Source table ('text_chunks' or 'global_text_chunks').
        owner_column: Column name for the owner scope.
        owner_id: Owner UUID or source_key.

    Returns:
        Tuple of (BM25Okapi instance, list of row dicts with id and content).

    Raises:
        ImportError: If rank-bm25 is not installed.
    """
    from rank_bm25 import BM25Okapi  # noqa: PLC0415

    cache_key = (table, owner_column, owner_id)
    now = time.monotonic()
    cached = _bm25_cache.get(cache_key)
    if cached is not None:
        ts, bm25_obj, rows = cached
        if now - ts < BM25_CACHE_TTL_SECS:
            return bm25_obj, rows

    records = await conn.fetch(
        f"""
        SELECT id, content
        FROM {table}
        WHERE {owner_column} = $1 AND embedding_status = 'ready'
        """,
        owner_id,
    )
    rows = [dict(r) for r in records]
    tokenized = [r["content"].lower().split() for r in rows]
    bm25_obj = BM25Okapi(tokenized) if tokenized else None
    _bm25_cache[cache_key] = (now, bm25_obj, rows)
    logger.debug("Built BM25 index for %s owner=%s (%d docs)", table, owner_id, len(rows))
    return bm25_obj, rows


async def dense_search(
    conn: asyncpg.Connection,
    table: str,
    owner_column: str,
    owner_id: str,
    query_embedding: np.ndarray,
    top_k: int = 20,
) -> list[dict]:
    """Perform dense cosine similarity search against a text_chunks table.

    Uses the <=> pgvector cosine distance operator. Returns results
    sorted by descending cosine similarity.

    Args:
        conn: An asyncpg connection.
        table: Target table ('text_chunks' or 'global_text_chunks').
        owner_column: Column for owner scope ('project_id' or 'source_key').
        owner_id: Owner UUID or source_key.
        query_embedding: Float32 numpy array of shape (dims,).
        top_k: Maximum number of results.

    Returns:
        List of dicts with id, file_path, chunk_index, chunk_type,
        header_context, content, source_type, and similarity (float).
    """
    rows = await conn.fetch(
        f"""
        SELECT
            id,
            file_path,
            chunk_index,
            chunk_type,
            header_context,
            content,
            source_type,
            1 - (embedding <=> $1) AS similarity
        FROM {table}
        WHERE {owner_column} = $2 AND embedding_status = 'ready'
        ORDER BY embedding <=> $1
        LIMIT $3
        """,
        np.asarray(query_embedding, dtype=np.float32),
        owner_id,
        top_k,
    )
    return [dict(r) for r in rows]


def _rrf_merge(
    dense_results: list[dict],
    sparse_results: list[dict],
    k: int = 60,
) -> list[dict]:
    """Merge dense and sparse result lists using Reciprocal Rank Fusion.

    RRF assigns score 1/(k + rank) to each document in each list and
    sums scores for documents appearing in both. This is score-agnostic
    and works regardless of BM25's raw score magnitude.

    Args:
        dense_results: Results from dense search, sorted best-first.
        sparse_results: Results from BM25 search, sorted best-first.
        k: RRF constant (default 60 per the original RRF paper).

    Returns:
        Combined list of result dicts with added rrf_score field,
        sorted by descending rrf_score. Dense result metadata is used
        for documents appearing in both lists.
    """
    # Build id→rank maps (1-based)
    dense_ranks = {r["id"]: i + 1 for i, r in enumerate(dense_results)}
    sparse_ranks = {r["id"]: i + 1 for i, r in enumerate(sparse_results)}

    # Collect all unique doc IDs with a lookup table for metadata
    all_ids: set[int] = set(dense_ranks) | set(sparse_ranks)
    id_to_meta: dict[int, dict] = {r["id"]: r for r in dense_results}
    for r in sparse_results:
        if r["id"] not in id_to_meta:
            id_to_meta[r["id"]] = r

    merged: list[dict] = []
    for doc_id in all_ids:
        score = 0.0
        if doc_id in dense_ranks:
            score += 1.0 / (k + dense_ranks[doc_id])
        if doc_id in sparse_ranks:
            score += 1.0 / (k + sparse_ranks[doc_id])
        entry = dict(id_to_meta[doc_id])
        entry["rrf_score"] = score
        entry.setdefault("bm25_score", 0.0)
        entry.setdefault("similarity", 0.0)
        merged.append(entry)

    merged.sort(key=lambda x: x["rrf_score"], reverse=True)
    return merged


async def hybrid_search(
    conn: asyncpg.Connection,
    table: str,
    owner_column: str,
    owner_id: str,
    query: str,
    query_embedding: np.ndarray,
    top_k: int = 10,
    use_reranker: bool = True,
    reranker: Any = None,
) -> list[dict]:
    """Perform hybrid (dense + BM25 + optional reranking) text retrieval.

    Combines dense cosine search and BM25 sparse search via Reciprocal
    Rank Fusion, then optionally applies a cross-encoder reranker to
    the merged candidates before returning the top-k results.

    Args:
        conn: An asyncpg connection.
        table: Target table ('text_chunks' or 'global_text_chunks').
        owner_column: Column for owner scope.
        owner_id: Owner UUID or source_key.
        query: Original query text (used for BM25 and reranking).
        query_embedding: Pre-computed float32 embedding of query.
        top_k: Number of results to return.
        use_reranker: Whether to apply cross-encoder reranking.
        reranker: A loaded CrossEncoder instance (optional). If None and
            use_reranker=True, reranking is skipped with a warning.

    Returns:
        List of result dicts (up to top_k) with fields: id, file_path,
        chunk_index, chunk_type, header_context, content, source_type,
        similarity, bm25_score, rrf_score, rerank_score.
    """
    # Dense retrieval — fetch extra candidates for reranking
    candidate_k = max(top_k * 3, 30)
    dense = await dense_search(conn, table, owner_column, owner_id, query_embedding, top_k=candidate_k)

    # BM25 retrieval
    bm25_results: list[dict] = []
    try:
        bm25_obj, bm25_rows = await _load_bm25(conn, table, owner_column, owner_id)
        if bm25_obj is not None and bm25_rows:
            query_tokens = query.lower().split()
            scores = bm25_obj.get_scores(query_tokens)
            # Build scored results sorted by BM25 score descending
            scored = sorted(
                zip(scores, bm25_rows), key=lambda x: x[0], reverse=True
            )[:candidate_k]
            bm25_results = [
                {**row, "bm25_score": float(score)}
                for score, row in scored
                if score > 0
            ]
    except ImportError:
        logger.warning("rank-bm25 not installed; falling back to dense-only retrieval")

    # Merge via RRF
    if bm25_results:
        candidates = _rrf_merge(dense, bm25_results)
    else:
        candidates = [{**r, "rrf_score": 0.0, "bm25_score": 0.0} for r in dense]

    # Optional cross-encoder reranking
    if use_reranker and reranker is not None:
        try:
            pairs = [(query, c["content"]) for c in candidates[:candidate_k]]
            rerank_scores: list[float] = reranker.predict(pairs).tolist()
            for candidate, score in zip(candidates, rerank_scores):
                candidate["rerank_score"] = score
            candidates.sort(key=lambda x: x.get("rerank_score", 0.0), reverse=True)
        except Exception:
            logger.warning("Reranking failed; returning RRF-ranked results", exc_info=True)
            for c in candidates:
                c.setdefault("rerank_score", 0.0)
    else:
        if use_reranker and reranker is None:
            logger.warning("use_reranker=True but no reranker instance provided; skipping reranking")
        for c in candidates:
            c.setdefault("rerank_score", 0.0)

    # Ensure all required fields present
    for c in candidates:
        c.setdefault("similarity", 0.0)
        c.setdefault("bm25_score", 0.0)
        c.setdefault("rrf_score", 0.0)
        c.setdefault("rerank_score", 0.0)

    return candidates[:top_k]
