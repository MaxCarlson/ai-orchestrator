"""
Repository embedding tool for the AI Orchestrator's memory system.

This script scans a code repository and generates vector embeddings for
each file or document, storing them as memories in the PostgreSQL
database. It is intended to run on the host system equipped with an
RTX 5090 GPU. Code files and prose documents are embedded using
different models specialised for their respective domains (e.g. a
code‑aware model for source files and a general language model for
README or design documents). The resulting embeddings are stored via
the :class:`memory.manager.MemoryManager`.

Example usage::

    python embed_repo.py \
        --repo-path /home/mcarls/projects/myrepo \
        --project-id <uuid-of-project> \
        --db-host localhost \
        --db-port 5432 \
        --db-name knowledge_manager \
        --db-user km_user \
        --db-password *****

When run, the tool will recursively walk ``repo-path`` and process
files with recognised extensions. For each file it will
    1. Read the file's content.
    2. Generate an embedding using the appropriate model.
    3. Insert a memory item into the database, tagged with the
       provided project ID and categories such as ``code`` or
       ``documentation``.

Embeddings for code and prose are generated using separate models to
capture domain‑specific semantics. The default models are BAAI
``bge-base-en-v1.5`` for prose and Salesforce ``codebert-base`` for
code. You can override these with command‑line arguments or modify
``load_models`` accordingly. Ensure you have installed the required
libraries (e.g. ``sentence-transformers`` or ``transformers``) and
that your environment uses the GPU (CUDA) to accelerate embedding
generation. See ``python_setup_module.txt`` for details on setting
up your Python environment.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import logging
import os
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

import asyncpg
import numpy as np

# The following imports are optional and require additional
# dependencies (e.g. sentence-transformers, transformers). They are
# imported lazily inside load_models to avoid import errors when the
# script is not used for embedding. If you choose different models,
# modify load_models accordingly.

from memory.manager import MemoryManager, initialize_schema


logger = logging.getLogger(__name__)


def chunk_text(text: str, max_chars: int = 1024, overlap: int = 128) -> List[str]:
    """Split a long document into overlapping chunks.

    This simple splitter preserves context by overlapping segments. It
    ensures no segment exceeds ``max_chars`` characters and that each
    segment overlaps by ``overlap`` characters with the previous one.
    """
    chunks: List[str] = []
    start = 0
    text = text.strip()
    while start < len(text):
        end = min(start + max_chars, len(text))
        chunk = text[start:end]
        chunks.append(chunk)
        start = end - overlap
        if start < 0:
            start = 0
            break
    return chunks


def load_models(
    code_model_name: str = "microsoft/codebert-base",
    text_model_name: str = "BAAI/bge-base-en-v1.5",
) -> Tuple[object, object]:
    """Load embedding models for code and prose.

    Returns a tuple ``(code_embedder, text_embedder)``. Each embedder
    must implement an ``encode(texts: List[str]) -> numpy.ndarray``
    method that returns an array of shape (n, d).

    You can override the default model names via command‑line options.
    Ensure that the necessary libraries are installed. For example,
    ``sentence-transformers`` for BGE or ``transformers`` for CodeBERT.
    """
    # Deferred imports to avoid heavy dependency at module import time
    try:
        from sentence_transformers import SentenceTransformer  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "Missing sentence-transformers. Install via pip: pip install sentence-transformers"
        ) from e

    code_embedder = SentenceTransformer(code_model_name)
    text_embedder = SentenceTransformer(text_model_name)
    return code_embedder, text_embedder


def select_model_for_file(path: Path) -> str:
    """Determine which embedding model to use based on file extension."""
    code_exts = {
        ".py", ".js", ".ts", ".cpp", ".c", ".cxx", ".h", ".java", ".go", ".rs", ".php", ".cs",
    }
    text_exts = {
        ".md", ".txt", ".rst", ".yaml", ".yml", ".toml", ".ini", ".json", ".html", ".css",
    }
    suffix = path.suffix.lower()
    if suffix in code_exts:
        return "code"
    if suffix in text_exts:
        return "text"
    # Default: treat unknown extensions as text to avoid skipping
    return "text"


def _hash_content(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8", errors="ignore")).hexdigest()


async def _insert_global_memory(
    conn: asyncpg.Connection,
    content: str,
    embedding: np.ndarray,
    source_key: str,
    source_project_id: Optional[str],
    created_by: str,
    categories: List[str],
) -> None:
    content_hash = _hash_content(content)
    record = await conn.fetchrow(
        """
        INSERT INTO global_memory_items (
            content,
            content_hash,
            embedding,
            source_key,
            source_project_id,
            created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (source_key, content_hash)
        DO UPDATE SET
            embedding = EXCLUDED.embedding,
            created_by = EXCLUDED.created_by,
            last_accessed_at = NOW()
        RETURNING memory_id
        """,
        content,
        content_hash,
        np.asarray(embedding, dtype=np.float32),
        source_key,
        source_project_id,
        created_by,
    )
    memory_id: str = record["memory_id"]
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
            INSERT INTO global_memory_categories (memory_id, category_id)
            VALUES ($1, $2)
            ON CONFLICT (memory_id, category_id) DO NOTHING
            """,
            memory_id,
            category_id,
        )


async def embed_repository(
    repo_path: Path,
    project_id: Optional[str],
    pool: asyncpg.Pool,
    code_model_name: str,
    text_model_name: str,
    scope: str = "auto",
    target: str = "project",
    source_key: Optional[str] = None,
    source_project_id: Optional[str] = None,
    batch_size: int = 8,
    include_pdfs: bool = True,
) -> Dict[str, int]:
    """Recursively embed all files in a repository and store them as memories.

    :param repo_path: Path to the root of the repository to embed.
    :param project_id: The UUID of the project to associate with these memories.
    :param pool: Asyncpg connection pool pointing to the knowledge_manager
        database.
    :param code_model_name: Hugging Face model identifier for code embedding.
    :param text_model_name: Hugging Face model identifier for prose embedding.
    :param batch_size: Number of chunks to embed at once.
    :param include_pdfs: Whether to include PDF files in text indexing.
    """
    logger.info(f"Embedding repository at {repo_path}")
    code_embedder, text_embedder = load_models(code_model_name, text_model_name)
    mgr = MemoryManager()

    files: List[Path] = [p for p in repo_path.rglob("*") if p.is_file()]
    logger.info(f"Found {len(files)} files to process")
    stats: Dict[str, int] = {
        "files_scanned": len(files),
        "code_files": 0,
        "text_files": 0,
        "unsupported_files": 0,
        "chunks_indexed": 0,
        "chunks_skipped": 0,
    }

    normalized_scope = scope.lower()
    normalized_target = target.lower()
    if normalized_target in {"global", "both"} and not source_key:
        raise RuntimeError("source_key is required for global embeddings")

    for file_path in files:
        if not include_pdfs and file_path.suffix.lower() == ".pdf":
            stats["unsupported_files"] += 1
            continue
        model_type = select_model_for_file(file_path)
        if model_type == "code":
            stats["code_files"] += 1
        elif model_type == "text":
            stats["text_files"] += 1
        else:
            stats["unsupported_files"] += 1
            continue

        if normalized_scope == "text" and model_type != "text":
            continue
        if normalized_scope == "code" and model_type != "code":
            continue
        try:
            data = file_path.read_text(errors="ignore")
        except Exception as e:
            logger.warning(f"Skipping {file_path}: {e}")
            continue
        chunks = chunk_text(data)
        # Process in batches to utilise vectorisation
        for i in range(0, len(chunks), batch_size):
            batch = chunks[i : i + batch_size]
            if not batch:
                continue
            if model_type == "code":
                embeddings = code_embedder.encode(batch, convert_to_numpy=True, normalize_embeddings=True)
                categories = ["code"]
            else:
                embeddings = text_embedder.encode(batch, convert_to_numpy=True, normalize_embeddings=True)
                categories = ["documentation"]
            async with pool.acquire() as conn:
                # Ensure schema is initialised once per connection
                await initialize_schema(conn)
                for chunk, emb in zip(batch, embeddings):
                    if normalized_target in {"project", "both"}:
                        await mgr.add_memory(
                            conn,
                            content=chunk,
                            embedding=emb,
                            project_id=project_id,
                            task_id=None,
                            system_id=None,
                            created_by="repo_embedder",
                            categories=categories,
                        )
                    if normalized_target in {"global", "both"}:
                        await _insert_global_memory(
                            conn,
                            content=chunk,
                            embedding=emb,
                            source_key=source_key or "",
                            source_project_id=source_project_id,
                            created_by="repo_embedder",
                            categories=categories,
                        )
                    stats["chunks_indexed"] += 1
        logger.debug(f"Indexed {file_path}")
    logger.info("Repository embedding complete")
    return stats


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Embed a repository into the memory system")
    p.add_argument("--repo-path", type=Path, required=True, help="Path to the repository root")
    p.add_argument("--project-id", type=str, default=None, help="UUID of the project (from kmtui)")
    p.add_argument("--scope", type=str, default="auto", help="auto | code | text")
    p.add_argument("--target", type=str, default="project", help="project | global | both")
    p.add_argument("--source-key", type=str, default=None, help="Global source key (required for global)")
    p.add_argument("--source-project-id", type=str, default=None, help="Optional project source for global")
    p.add_argument("--db-host", type=str, default="localhost", help="PostgreSQL host")
    p.add_argument("--db-port", type=int, default=5432, help="PostgreSQL port")
    p.add_argument("--db-name", type=str, default="knowledge_manager", help="Database name")
    p.add_argument("--db-user", type=str, default="km_user", help="Database user")
    p.add_argument("--db-password", type=str, required=False, help="Database password")
    p.add_argument("--code-model", type=str, default="microsoft/codebert-base", help="Model for code embeddings")
    p.add_argument("--text-model", type=str, default="BAAI/bge-base-en-v1.5", help="Model for text embeddings")
    p.add_argument("--batch-size", type=int, default=8, help="Embedding batch size")
    return p.parse_args()


async def main() -> None:
    args = parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
    db_password = args.db_password or os.getenv("POSTGRES_PASSWORD")
    if not db_password:
        raise RuntimeError("POSTGRES_PASSWORD env or --db-password is required")
    source_project_id = args.source_project_id or args.project_id
    pool = await asyncpg.create_pool(
        host=args.db_host,
        port=args.db_port,
        user=args.db_user,
        password=db_password,
        database=args.db_name,
    )
    try:
        await embed_repository(
            repo_path=args.repo_path,
            project_id=args.project_id,
            pool=pool,
            code_model_name=args.code_model,
            text_model_name=args.text_model,
            scope=args.scope,
            target=args.target,
            source_key=args.source_key,
            source_project_id=source_project_id,
            batch_size=args.batch_size,
        )
    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
