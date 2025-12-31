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
import logging
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


async def embed_repository(
    repo_path: Path,
    project_id: Optional[str],
    pool: asyncpg.Pool,
    code_model_name: str,
    text_model_name: str,
    batch_size: int = 8,
) -> None:
    """Recursively embed all files in a repository and store them as memories.

    :param repo_path: Path to the root of the repository to embed.
    :param project_id: The UUID of the project to associate with these memories.
    :param pool: Asyncpg connection pool pointing to the knowledge_manager
        database.
    :param code_model_name: Hugging Face model identifier for code embedding.
    :param text_model_name: Hugging Face model identifier for prose embedding.
    :param batch_size: Number of chunks to embed at once.
    """
    logger.info(f"Embedding repository at {repo_path}")
    code_embedder, text_embedder = load_models(code_model_name, text_model_name)
    mgr = MemoryManager()

    files: List[Path] = [p for p in repo_path.rglob("*") if p.is_file()]
    logger.info(f"Found {len(files)} files to process")
    for file_path in files:
        model_type = select_model_for_file(file_path)
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
        logger.debug(f"Indexed {file_path}")
    logger.info("Repository embedding complete")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Embed a repository into the memory system")
    p.add_argument("--repo-path", type=Path, required=True, help="Path to the repository root")
    p.add_argument("--project-id", type=str, default=None, help="UUID of the project (from kmtui)")
    p.add_argument("--db-host", type=str, default="localhost", help="PostgreSQL host")
    p.add_argument("--db-port", type=int, default=5432, help="PostgreSQL port")
    p.add_argument("--db-name", type=str, default="knowledge_manager", help="Database name")
    p.add_argument("--db-user", type=str, default="km_user", help="Database user")
    p.add_argument("--db-password", type=str, required=True, help="Database password")
    p.add_argument("--code-model", type=str, default="microsoft/codebert-base", help="Model for code embeddings")
    p.add_argument("--text-model", type=str, default="BAAI/bge-base-en-v1.5", help="Model for text embeddings")
    p.add_argument("--batch-size", type=int, default=8, help="Embedding batch size")
    return p.parse_args()


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
        await embed_repository(
            repo_path=args.repo_path,
            project_id=args.project_id,
            pool=pool,
            code_model_name=args.code_model,
            text_model_name=args.text_model,
            batch_size=args.batch_size,
        )
    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
