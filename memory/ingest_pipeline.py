"""
Text document ingest pipeline for the per-project RAG system.

Loads plain-text, markdown, and PDF documents using LangChain loaders,
splits them with structure-aware splitters, embeds with the text
embedding model, and upserts into the text_chunks or global_text_chunks
table with full per-file chunk reconciliation.

This module supersedes the text-mode logic in embed_repo.py for
structured document ingestion. The embed_repo.py unstructured
memory_items approach is retained for runtime LLM memory; this module
handles document indexing.
"""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from pathlib import Path
from typing import Any, Awaitable, Callable

import asyncpg
import numpy as np

from memory.langchain_loaders import load_all_documents, load_raw_text
from memory.langchain_splitters import split_documents
from memory.text_embeddings import TextEmbedder


logger = logging.getLogger(__name__)

DEFAULT_BATCH_SIZE = 8
DEFAULT_MODEL = "BAAI/bge-base-en-v1.5"


async def _fetch_existing_chunks(
    conn: asyncpg.Connection,
    table: str,
    owner_column: str,
    owner_id: str,
    file_path: str,
) -> dict[int, str]:
    """Fetch existing (chunk_index, content_hash) pairs for a file.

    Args:
        conn: An asyncpg connection.
        table: Target table name.
        owner_column: Column name for the owner scope (e.g. 'project_id').
        owner_id: Owner UUID or source_key string.
        file_path: Source file path to query.

    Returns:
        Mapping of chunk_index -> content_hash for all existing rows.
    """
    rows = await conn.fetch(
        f"""
        SELECT chunk_index, content_hash
        FROM {table}
        WHERE {owner_column} = $1 AND file_path = $2
        """,
        owner_id,
        file_path,
    )
    return {row["chunk_index"]: row["content_hash"] for row in rows}


async def _delete_stale_chunks(
    conn: asyncpg.Connection,
    table: str,
    owner_column: str,
    owner_id: str,
    file_path: str,
    new_chunk_count: int,
) -> int:
    """Delete chunks with chunk_index >= new_chunk_count (file was shortened).

    Args:
        conn: An asyncpg connection.
        table: Target table name.
        owner_column: Column name for the owner scope.
        owner_id: Owner UUID or source_key.
        file_path: Source file path.
        new_chunk_count: Number of chunks produced by re-splitting the file.

    Returns:
        Number of rows deleted.
    """
    result = await conn.execute(
        f"""
        DELETE FROM {table}
        WHERE {owner_column} = $1 AND file_path = $2 AND chunk_index >= $3
        """,
        owner_id,
        file_path,
        new_chunk_count,
    )
    # asyncpg returns "DELETE N" as a string
    deleted = int(result.split()[-1]) if result else 0
    if deleted:
        logger.debug("Deleted %d stale chunks from %s for file %s", deleted, table, file_path)
    return deleted


async def _upsert_text_chunk(
    conn: asyncpg.Connection,
    table: str,
    owner_column: str,
    owner_id: str,
    chunk_doc: Any,  # LangChain Document
    embedding: np.ndarray,
    model_name: str,
    source_project_id: str | None = None,
) -> None:
    """Upsert a single text chunk into the target table.

    Args:
        conn: An asyncpg connection.
        table: Target table ('text_chunks' or 'global_text_chunks').
        owner_column: 'project_id' or 'source_key'.
        owner_id: Owner UUID or source_key hash.
        chunk_doc: LangChain Document with enriched metadata from split_documents().
        embedding: Float32 numpy array of shape (768,).
        model_name: Embedding model ID for provenance.
        source_project_id: For global tables, the originating project UUID.
    """
    meta = chunk_doc.metadata
    content = chunk_doc.page_content

    if table == "global_text_chunks":
        await conn.execute(
            """
            INSERT INTO global_text_chunks (
                source_key, source_project_id, file_path, chunk_index,
                chunk_type, header_context, start_char, end_char,
                content, content_hash, source_type,
                embedding, embedding_model, embedding_status, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'ready', NOW())
            ON CONFLICT (source_key, file_path, chunk_index)
            DO UPDATE SET
                chunk_type       = EXCLUDED.chunk_type,
                header_context   = EXCLUDED.header_context,
                start_char       = EXCLUDED.start_char,
                end_char         = EXCLUDED.end_char,
                content          = EXCLUDED.content,
                content_hash     = EXCLUDED.content_hash,
                source_type      = EXCLUDED.source_type,
                embedding        = EXCLUDED.embedding,
                embedding_model  = EXCLUDED.embedding_model,
                embedding_status = EXCLUDED.embedding_status,
                updated_at       = NOW()
            """,
            owner_id,
            source_project_id,
            meta.get("file_path", meta.get("source", "")),
            meta["chunk_index"],
            meta.get("chunk_type", "text"),
            meta.get("header_context", ""),
            meta.get("start_char", 0),
            meta.get("end_char", 0),
            content,
            meta["content_hash"],
            meta.get("source_type", "file"),
            embedding,
            model_name,
        )
    else:
        await conn.execute(
            """
            INSERT INTO text_chunks (
                project_id, file_path, chunk_index,
                chunk_type, header_context, start_char, end_char,
                content, content_hash, source_type,
                embedding, embedding_model, embedding_status, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'ready', NOW())
            ON CONFLICT (project_id, file_path, chunk_index)
            DO UPDATE SET
                chunk_type       = EXCLUDED.chunk_type,
                header_context   = EXCLUDED.header_context,
                start_char       = EXCLUDED.start_char,
                end_char         = EXCLUDED.end_char,
                content          = EXCLUDED.content,
                content_hash     = EXCLUDED.content_hash,
                source_type      = EXCLUDED.source_type,
                embedding        = EXCLUDED.embedding,
                embedding_model  = EXCLUDED.embedding_model,
                embedding_status = EXCLUDED.embedding_status,
                updated_at       = NOW()
            """,
            owner_id,
            meta.get("file_path", meta.get("source", "")),
            meta["chunk_index"],
            meta.get("chunk_type", "text"),
            meta.get("header_context", ""),
            meta.get("start_char", 0),
            meta.get("end_char", 0),
            content,
            meta["content_hash"],
            meta.get("source_type", "file"),
            embedding,
            model_name,
        )


async def index_text_documents(
    doc_path: Path,
    owner_id: str,
    pool: asyncpg.Pool,
    model_name: str = DEFAULT_MODEL,
    batch_size: int = DEFAULT_BATCH_SIZE,
    force_reindex: bool = False,
    table: str = "text_chunks",
    owner_column: str = "project_id",
    source_project_id: str | None = None,
    include_pdfs: bool = True,
    progress_cb: Callable[[dict, str, int, int], Awaitable[None]] | None = None,
    progress_interval: int = 20,
) -> dict:
    """Index text documents from a directory into text_chunks.

    Loads plain-text, markdown, and optionally PDF documents, splits
    them, embeds them, and upserts into *table*. Uses full per-file
    reconciliation: existing chunks are compared by content_hash, stale
    chunks (chunk_index >= new chunk count) are deleted.

    Args:
        doc_path: Root directory to load documents from.
        owner_id: Project UUID (for text_chunks) or source_key (for global).
        pool: asyncpg connection pool.
        model_name: HuggingFace model ID for text embeddings.
        batch_size: Number of chunks to embed in one forward pass.
        force_reindex: If True, re-embed even unchanged chunks.
        table: Target table ('text_chunks' or 'global_text_chunks').
        owner_column: Column name for owner scope ('project_id' or 'source_key').
        source_project_id: For global tables, the originating project UUID.
        include_pdfs: Whether to include PDF documents.
        progress_cb: Optional async callback invoked periodically with
            (stats_snapshot, current_file, files_processed, files_total).
        progress_interval: Invoke progress_cb every N files.

    Returns:
        Stats dict with keys: files_scanned, files_processed, files_indexed,
        chunks_indexed, chunks_skipped, chunks_deleted.
    """
    embedder = TextEmbedder(model_name=model_name)

    # Load and split all documents upfront
    raw_docs = load_all_documents(doc_path, include_pdfs=include_pdfs)
    chunks = split_documents(raw_docs)

    # Group chunks by source file for per-file reconciliation
    chunks_by_file: dict[str, list] = defaultdict(list)
    for chunk in chunks:
        source = chunk.metadata.get("file_path", chunk.metadata.get("source", ""))
        chunks_by_file[source].append(chunk)

    files = list(chunks_by_file.keys())
    total_files = len(files)

    stats: dict[str, Any] = {
        "files_scanned": len({
            d.metadata.get("file_path", d.metadata.get("source", ""))
            for d in raw_docs
        }),
        "files_processed": 0,
        "files_indexed": 0,
        "chunks_indexed": 0,
        "chunks_skipped": 0,
        "chunks_deleted": 0,
    }

    logger.info(
        "Indexing %d documents (%d source files) into %s",
        len(raw_docs),
        total_files,
        table,
    )

    for processed_idx, file_path in enumerate(files, start=1):
        file_chunks = chunks_by_file[file_path]
        stats["files_processed"] = processed_idx

        # Per-file reconciliation: fetch existing chunk hashes
        async with pool.acquire() as conn:
            existing: dict[int, str] = await _fetch_existing_chunks(
                conn, table, owner_column, owner_id, file_path
            )

        # Determine which chunks need (re-)embedding
        pending = []
        for chunk_doc in file_chunks:
            idx = chunk_doc.metadata["chunk_index"]
            existing_hash = existing.get(idx)
            if existing_hash == chunk_doc.metadata["content_hash"] and not force_reindex:
                stats["chunks_skipped"] += 1
            else:
                pending.append(chunk_doc)

        # Embed and upsert pending chunks in batches
        if pending:
            for batch_start in range(0, len(pending), batch_size):
                batch = pending[batch_start : batch_start + batch_size]
                texts = [doc.page_content for doc in batch]
                embeddings: np.ndarray = embedder.embed_batch(texts)
                async with pool.acquire() as conn:
                    for chunk_doc, embedding in zip(batch, embeddings):
                        await _upsert_text_chunk(
                            conn,
                            table,
                            owner_column,
                            owner_id,
                            chunk_doc,
                            embedding,
                            model_name,
                            source_project_id=source_project_id,
                        )
                stats["chunks_indexed"] += len(batch)
            stats["files_indexed"] += 1

        # Always clean up orphaned high-index chunks
        new_chunk_count = len(file_chunks)
        async with pool.acquire() as conn:
            deleted = await _delete_stale_chunks(
                conn, table, owner_column, owner_id, file_path, new_chunk_count
            )
        stats["chunks_deleted"] += deleted

        if progress_cb and (
            processed_idx % progress_interval == 0 or processed_idx == total_files
        ):
            await progress_cb(dict(stats), file_path, processed_idx, total_files)

    logger.info(
        "Text indexing complete: %d indexed, %d skipped, %d deleted",
        stats["chunks_indexed"],
        stats["chunks_skipped"],
        stats["chunks_deleted"],
    )
    return stats


async def ingest_text_direct(
    content: str,
    source_label: str,
    project_id: str,
    pool: asyncpg.Pool,
    model_name: str = DEFAULT_MODEL,
) -> int:
    """Ingest raw text content directly into text_chunks without a TaskQueue job.

    Intended for small API-submitted documents (notes, snippets). Splits
    the content, embeds, and upserts synchronously. Invalidates the BM25
    cache for the project after writing.

    Args:
        content: Raw text to ingest.
        source_label: Identifier used as file_path (e.g. 'note-2026-04-02').
        project_id: UUID of the project to store the chunks under.
        pool: asyncpg connection pool.
        model_name: Embedding model ID.

    Returns:
        Number of chunks stored.
    """
    embedder = TextEmbedder(model_name=model_name)
    doc = load_raw_text(content, source_label)
    chunks = split_documents([doc])

    if not chunks:
        return 0

    texts = [c.page_content for c in chunks]
    embeddings: np.ndarray = embedder.embed_batch(texts)

    async with pool.acquire() as conn:
        for chunk_doc, embedding in zip(chunks, embeddings):
            await _upsert_text_chunk(
                conn,
                "text_chunks",
                "project_id",
                project_id,
                chunk_doc,
                embedding,
                model_name,
            )

    # Invalidate BM25 cache for this project (imported lazily to avoid circular)
    try:
        from memory.retrieval import invalidate_bm25_cache  # noqa: PLC0415
        invalidate_bm25_cache(project_id)
    except ImportError:
        pass  # retrieval module not yet available (Phase 4)

    logger.info("Ingested %d chunks for source_label=%r, project_id=%s", len(chunks), source_label, project_id)
    return len(chunks)
