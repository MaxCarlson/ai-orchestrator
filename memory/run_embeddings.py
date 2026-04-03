"""
Unified embedding runner for project and global indexing.

Runs code indexing with the code-optimized pipeline and text indexing
with the text pipeline, then records stats in the database.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional

import asyncpg

from memory.code_indexer import index_repository
from memory.embed_repo import embed_repository
from memory.manager import initialize_schema


logger = logging.getLogger(__name__)


def _source_key(repo_path: Path) -> str:
    return hashlib.sha256(str(repo_path).encode("utf-8", errors="ignore")).hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run embedding pipelines for a repository.")
    parser.add_argument("--repo-path", type=Path, required=True)
    parser.add_argument("--project-id", type=str, default=None)
    parser.add_argument("--mode", type=str, default="auto", help="auto | code | text")
    parser.add_argument("--target", type=str, default="project", help="project | global | both")
    parser.add_argument("--code-model", type=str, default="microsoft/codebert-base")
    parser.add_argument("--text-model", type=str, default="BAAI/bge-base-en-v1.5")
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--force-reindex", action="store_true")
    parser.add_argument("--include-pdfs", dest="include_pdfs", action=argparse.BooleanOptionalAction, default=True, help="Include PDF files in text indexing")
    parser.add_argument("--db-host", default="localhost")
    parser.add_argument("--db-port", type=int, default=5432)
    parser.add_argument("--db-name", default="knowledge_manager")
    parser.add_argument("--db-user", default="km_user")
    parser.add_argument("--db-password", default=None)
    return parser.parse_args()


async def _create_run(
    conn: asyncpg.Connection,
    project_id: Optional[str],
    target: str,
    mode: str,
) -> str:
    row = await conn.fetchrow(
        """
        INSERT INTO embedding_runs (project_id, target, mode, status, started_at, updated_at)
        VALUES ($1, $2, $3, 'running', NOW(), NOW())
        RETURNING run_id
        """,
        project_id,
        target,
        mode,
    )
    return str(row["run_id"])


async def _finish_run(
    conn: asyncpg.Connection,
    run_id: str,
    status: str,
    stats: Dict[str, Any],
    error: Optional[str] = None,
) -> None:
    await conn.execute(
        """
        UPDATE embedding_runs
        SET status = $2,
            stats = $3::jsonb,
            error = $4,
            finished_at = NOW(),
            updated_at = NOW()
        WHERE run_id = $1
        """,
        run_id,
        status,
        stats,
        error,
    )


async def _update_run_progress(
    conn: asyncpg.Connection,
    run_id: str,
    stats: Dict[str, Any],
    progress: Dict[str, Any],
) -> None:
    stats["progress"] = progress
    await conn.execute(
        """
        UPDATE embedding_runs
        SET stats = $2::jsonb,
            updated_at = NOW()
        WHERE run_id = $1
        """,
        run_id,
        stats,
    )


async def _update_project_tracking(
    conn: asyncpg.Connection,
    project_id: str,
    *,
    target: str,
    mode: str,
    code_model: str,
    text_model: str,
    status: str,
    embedding_stats: Optional[Dict[str, Any]] = None,
    global_embedding_stats: Optional[Dict[str, Any]] = None,
) -> None:
    if target in {"project", "both"}:
        await conn.execute(
            """
            UPDATE project_tracking
            SET embedding_status = $2,
                embedding_last_indexed = CASE
                    WHEN $2 = 'ready' THEN NOW()
                    ELSE embedding_last_indexed
                END,
                embedding_model_id = $3,
                text_embedding_model_id = $4,
                embedding_mode = $5,
                embedding_stats = $6::jsonb,
                updated_at = NOW()
            WHERE project_id = $1
            """,
            project_id,
            status,
            code_model,
            text_model,
            mode,
            embedding_stats,
        )

    if target in {"global", "both"}:
        await conn.execute(
            """
            UPDATE project_tracking
            SET global_embedding_status = $2,
                global_embedding_last_indexed = CASE
                    WHEN $2 = 'ready' THEN NOW()
                    ELSE global_embedding_last_indexed
                END,
                global_code_model_id = $3,
                global_text_model_id = $4,
                global_embedding_mode = $5,
                global_embedding_stats = $6::jsonb,
                updated_at = NOW()
            WHERE project_id = $1
            """,
            project_id,
            status,
            code_model,
            text_model,
            mode,
            global_embedding_stats,
        )


async def run_embeddings() -> None:
    args = parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")

    db_password = args.db_password or os.getenv("POSTGRES_PASSWORD")
    if not db_password:
        raise RuntimeError("POSTGRES_PASSWORD env or --db-password is required")

    mode = args.mode.lower()
    target = args.target.lower()
    if mode not in {"auto", "code", "text"}:
        raise RuntimeError(f"Invalid mode: {mode}")
    if target not in {"project", "global", "both"}:
        raise RuntimeError(f"Invalid target: {target}")
    if target in {"project", "both"} and not args.project_id:
        raise RuntimeError("project-id required when target includes project")

    pool = await asyncpg.create_pool(
        host=args.db_host,
        port=args.db_port,
        user=args.db_user,
        password=db_password,
        database=args.db_name,
    )

    source_key = _source_key(args.repo_path)
    run_id = None
    stats: Dict[str, Any] = {
        "mode": mode,
        "target": target,
        "code": {},
        "text": {},
    }

    try:
        async with pool.acquire() as conn:
            await initialize_schema(conn)
            run_id = await _create_run(conn, args.project_id, target, mode)
            if args.project_id:
                await _update_project_tracking(
                    conn,
                    args.project_id,
                    target=target,
                    mode=mode,
                    code_model=args.code_model,
                    text_model=args.text_model,
                    status="indexing",
                )

        if mode in {"auto", "code"}:
            async def progress_cb(snapshot: Dict[str, Any], current_file: str, processed: int, total: int) -> None:
                if not run_id:
                    return
                progress = {
                    "current_file": current_file,
                    "files_processed": processed,
                    "files_total": total,
                    "ast_success": snapshot.get("ast_success", 0),
                    "ast_failure": snapshot.get("ast_failure", 0),
                    "code_files": snapshot.get("code_files", 0),
                    "text_files": snapshot.get("text_files", 0),
                    "unsupported_files": snapshot.get("unsupported_files", 0),
                    "chunks_indexed": snapshot.get("chunks_indexed", 0),
                    "chunks_skipped": snapshot.get("chunks_skipped", 0),
                }
                async with pool.acquire() as progress_conn:
                    await _update_run_progress(progress_conn, run_id, stats, progress)

            if target in {"project", "both"} and args.project_id:
                code_stats = await index_repository(
                    repo_path=args.repo_path,
                    owner_id=args.project_id,
                    pool=pool,
                    model_name=args.code_model,
                    batch_size=args.batch_size,
                    force_reindex=args.force_reindex,
                    table="code_chunks",
                    owner_column="project_id",
                    progress_cb=progress_cb,
                )
                stats["code"]["project"] = code_stats
            if target in {"global", "both"}:
                code_stats = await index_repository(
                    repo_path=args.repo_path,
                    owner_id=source_key,
                    pool=pool,
                    model_name=args.code_model,
                    batch_size=args.batch_size,
                    force_reindex=args.force_reindex,
                    table="global_code_chunks",
                    owner_column="source_key",
                    source_project_id=args.project_id,
                    progress_cb=progress_cb,
                )
                stats["code"]["global"] = code_stats

        if mode in {"auto", "text"}:
            text_stats = await embed_repository(
                repo_path=args.repo_path,
                project_id=args.project_id,
                pool=pool,
                code_model_name=args.code_model,
                text_model_name=args.text_model,
                scope="text",
                target=target,
                source_key=source_key,
                source_project_id=args.project_id,
                batch_size=args.batch_size,
                include_pdfs=args.include_pdfs,
            )
            stats["text"]["summary"] = text_stats

        async with pool.acquire() as conn:
            if run_id:
                await _finish_run(conn, run_id, "ready", stats)
            if args.project_id:
                project_stats = stats if target in {"project", "both"} else None
                global_stats = stats if target in {"global", "both"} else None
                await _update_project_tracking(
                    conn,
                    args.project_id,
                    target=target,
                    mode=mode,
                    code_model=args.code_model,
                    text_model=args.text_model,
                    status="ready",
                    embedding_stats=project_stats,
                    global_embedding_stats=global_stats,
                )
    except Exception as exc:
        logger.error("Embedding run failed: %s", exc, exc_info=True)
        async with pool.acquire() as conn:
            if run_id:
                await _finish_run(conn, run_id, "error", stats, error=str(exc))
            if args.project_id:
                await _update_project_tracking(
                    conn,
                    args.project_id,
                    target=target,
                    mode=mode,
                    code_model=args.code_model,
                    text_model=args.text_model,
                    status="error",
                )
        raise
    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(run_embeddings())
