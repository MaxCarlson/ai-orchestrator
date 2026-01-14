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
from typing import Dict, List, Tuple

import asyncpg
import numpy as np

from memory.code_chunking import CodeChunk, chunk_file
from memory.code_embeddings import CodeEmbedder
from memory.manager import initialize_schema


logger = logging.getLogger(__name__)


async def _fetch_existing_hashes(
    conn: asyncpg.Connection, project_id: str, file_path: str
) -> Dict[str, str]:
    rows = await conn.fetch(
        """
        SELECT symbol_name, content_hash
        FROM code_chunks
        WHERE project_id = $1 AND file_path = $2
        """,
        project_id,
        file_path,
    )
    return {row["symbol_name"]: row["content_hash"] for row in rows}


async def _upsert_chunk(
    conn: asyncpg.Connection,
    project_id: str,
    chunk: CodeChunk,
    embedding: np.ndarray,
    model_name: str,
    force_reindex: bool,
) -> bool:
    existing_hash = await conn.fetchval(
        """
        SELECT content_hash
        FROM code_chunks
        WHERE project_id = $1 AND file_path = $2 AND symbol_name = $3
        """,
        project_id,
        chunk.file_path,
        chunk.symbol_name,
    )
    if existing_hash and existing_hash == chunk.content_hash and not force_reindex:
        return False

    await conn.execute(
        """
        INSERT INTO code_chunks (
            project_id,
            file_path,
            symbol_name,
            chunk_type,
            start_line,
            end_line,
            content,
            content_hash,
            embedding,
            embedding_model,
            language,
            embedding_status,
            updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'ready', NOW())
        ON CONFLICT (project_id, file_path, symbol_name)
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
        """,
        project_id,
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
    )
    return True


async def index_repository(
    repo_path: Path,
    project_id: str,
    pool: asyncpg.Pool,
    model_name: str,
    batch_size: int,
    force_reindex: bool,
) -> None:
    embedder = CodeEmbedder(model_name=model_name)
    files = [path for path in repo_path.rglob("*") if path.is_file()]
    logger.info("Scanning %s files under %s", len(files), repo_path)

    indexed = 0
    skipped = 0
    for path in files:
        chunks = chunk_file(path)
        if not chunks:
            continue

        async with pool.acquire() as conn:
            await initialize_schema(conn)
            existing = await _fetch_existing_hashes(conn, project_id, str(path))

        pending_chunks: List[CodeChunk] = []
        for chunk in chunks:
            existing_hash = existing.get(chunk.symbol_name)
            if existing_hash and existing_hash == chunk.content_hash and not force_reindex:
                skipped += 1
                continue
            pending_chunks.append(chunk)

        for i in range(0, len(pending_chunks), batch_size):
            batch = pending_chunks[i : i + batch_size]
            embeddings = embedder.embed_code_batch([c.content for c in batch])
            async with pool.acquire() as conn:
                for chunk, embedding in zip(batch, embeddings):
                    updated = await _upsert_chunk(
                        conn,
                        project_id,
                        chunk,
                        embedding,
                        model_name,
                        force_reindex,
                    )
                    indexed += 1 if updated else 0

    logger.info("Indexing complete: %s updated, %s skipped", indexed, skipped)


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
            project_id=args.project_id,
            pool=pool,
            model_name=args.model,
            batch_size=args.batch_size,
            force_reindex=args.force_reindex,
        )
    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
