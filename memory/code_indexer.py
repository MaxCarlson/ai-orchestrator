"""
Code-aware repository indexer.

This script chunks code at the symbol level, embeds new/changed chunks,
and stores them in the code_chunks table.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
from pathlib import Path
from typing import Awaitable, Callable, Dict, List, Optional, Tuple

import asyncpg
import numpy as np

from memory.code_chunking import CodeChunk, chunk_file_with_stats
from memory.code_embeddings import CodeEmbedder
from memory.manager import initialize_schema


logger = logging.getLogger(__name__)


async def _fetch_existing_hashes(
    conn: asyncpg.Connection,
    table: str,
    owner_column: str,
    owner_id: str,
    file_path: str,
) -> Dict[str, str]:
    rows = await conn.fetch(
        f"""
        SELECT symbol_name, content_hash
        FROM {table}
        WHERE {owner_column} = $1 AND file_path = $2
        """,
        owner_id,
        file_path,
    )
    return {row["symbol_name"]: row["content_hash"] for row in rows}


async def _upsert_chunk(
    conn: asyncpg.Connection,
    table: str,
    owner_column: str,
    owner_id: str,
    chunk: CodeChunk,
    embedding: np.ndarray,
    model_name: str,
    force_reindex: bool,
    source_project_id: str | None = None,
) -> bool:
    existing_hash = await conn.fetchval(
        f"""
        SELECT content_hash
        FROM {table}
        WHERE {owner_column} = $1 AND file_path = $2 AND symbol_name = $3
        """,
        owner_id,
        chunk.file_path,
        chunk.symbol_name,
    )
    if existing_hash and existing_hash == chunk.content_hash and not force_reindex:
        return False

    columns = [
        owner_column,
        "file_path",
        "symbol_name",
        "chunk_type",
        "start_line",
        "end_line",
        "content",
        "content_hash",
        "embedding",
        "embedding_model",
        "language",
        "embedding_status",
        "updated_at",
    ]
    values = [
        owner_id,
        chunk.file_path,
        chunk.symbol_name,
        chunk.chunk_type,
        chunk.start_line,
        chunk.end_line,
        chunk.content,
        chunk.content_hash,
        embedding,
        model_name,
        chunk.language,
        "ready",
        "NOW()",
    ]

    if table == "global_code_chunks":
        columns.insert(1, "source_project_id")
        values.insert(1, source_project_id)

    value_placeholders = ", ".join(
        f"${idx}" if value != "NOW()" else "NOW()"
        for idx, value in enumerate(values, start=1)
    )
    insert_columns = ", ".join(columns)
    conflict_target = f"({owner_column}, file_path, symbol_name)"

    sql = f"""
        INSERT INTO {table} ({insert_columns})
        VALUES ({value_placeholders})
        ON CONFLICT {conflict_target}
        DO UPDATE SET
            chunk_type = EXCLUDED.chunk_type,
            start_line = EXCLUDED.start_line,
            end_line = EXCLUDED.end_line,
            content = EXCLUDED.content,
            content_hash = EXCLUDED.content_hash,
            embedding = EXCLUDED.embedding,
            embedding_model = EXCLUDED.embedding_model,
            language = EXCLUDED.language,
            embedding_status = EXCLUDED.embedding_status,
            updated_at = NOW()
    """

    await conn.execute(sql, *[v for v in values if v != "NOW()"])
    return True


async def index_repository(
    repo_path: Path,
    owner_id: str,
    pool: asyncpg.Pool,
    model_name: str,
    batch_size: int,
    force_reindex: bool,
    table: str = "code_chunks",
    owner_column: str = "project_id",
    source_project_id: str | None = None,
    progress_cb: Optional[Callable[[dict, str, int, int], Awaitable[None]]] = None,
    progress_interval: int = 20,
) -> dict:
    embedder = CodeEmbedder(model_name=model_name)
    files = [path for path in repo_path.rglob("*") if path.is_file()]
    logger.info("Scanning %s files under %s", len(files), repo_path)

    stats = {
        "files_scanned": len(files),
        "files_processed": 0,
        "code_files": 0,
        "text_files": 0,
        "unsupported_files": 0,
        "ast_success": 0,
        "ast_failure": 0,
        "chunks_indexed": 0,
        "chunks_skipped": 0,
    }

    total_files = len(files)
    processed = 0
    indexed = 0
    skipped = 0
    for path in files:
        processed += 1
        stats["files_processed"] = processed
        chunks, file_stats = chunk_file_with_stats(path, include_text=False)
        if file_stats.file_type == "python":
            stats["code_files"] += 1
            if file_stats.ast_status == "success":
                stats["ast_success"] += 1
            elif file_stats.ast_status == "failure":
                stats["ast_failure"] += 1
        elif file_stats.file_type == "text":
            stats["text_files"] += 1
        else:
            stats["unsupported_files"] += 1

        if not chunks:
            continue

        async with pool.acquire() as conn:
            await initialize_schema(conn)
            existing = await _fetch_existing_hashes(conn, table, owner_column, owner_id, str(path))

        pending_chunks: List[CodeChunk] = []
        for chunk in chunks:
            existing_hash = existing.get(chunk.symbol_name)
            if existing_hash and existing_hash == chunk.content_hash and not force_reindex:
                skipped += 1
                stats["chunks_skipped"] += 1
                continue
            pending_chunks.append(chunk)

        for i in range(0, len(pending_chunks), batch_size):
            batch = pending_chunks[i : i + batch_size]
            embeddings = embedder.embed_code_batch([c.content for c in batch])
            async with pool.acquire() as conn:
                for chunk, embedding in zip(batch, embeddings):
                    updated = await _upsert_chunk(
                        conn,
                        table,
                        owner_column,
                        owner_id,
                        chunk,
                        embedding,
                        model_name,
                        force_reindex,
                        source_project_id=source_project_id,
                    )
                    indexed += 1 if updated else 0
                    stats["chunks_indexed"] += 1 if updated else 0

        if progress_cb and (
            processed % progress_interval == 0 or processed == total_files
        ):
            await progress_cb(dict(stats), str(path), processed, total_files)

    logger.info("Indexing complete: %s updated, %s skipped", indexed, skipped)
    return stats


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Index repository code into code_chunks.")
    parser.add_argument("--repo-path", type=Path, required=True)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--db-host", default="localhost")
    parser.add_argument("--db-port", type=int, default=5432)
    parser.add_argument("--db-name", default="knowledge_manager")
    parser.add_argument("--db-user", default="km_user")
    parser.add_argument("--db-password", required=True)
    parser.add_argument("--model", default="microsoft/codebert-base")
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--force-reindex", action="store_true")
    return parser.parse_args()


async def main() -> None:
    args = parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
    pool = await asyncpg.create_pool(
        host=args.db_host,
        port=args.db_port,
        user=args.db_user,
        password=args.db_password,
        database=args.db_name,
    )
    try:
        await index_repository(
            repo_path=args.repo_path,
            owner_id=args.project_id,
            pool=pool,
            model_name=args.model,
            batch_size=args.batch_size,
            force_reindex=args.force_reindex,
        )
    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
