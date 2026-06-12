"""
AI Orchestrator - Task Dispatcher and Coordinator
Manages task assignment to external CLIs and local LLMs on RTX 5090
"""
import asyncio
import json
import logging
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator, List, Optional, Literal

import asyncpg
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings

from memory.code_embeddings import CodeEmbedder
from memory.code_search import search_code
from memory.manager import MemoryManager, initialize_schema
from memory.model_registry import register_model
from memory.retrieval import hybrid_search, invalidate_bm25_cache
from memory.source_ingestion import (
    GLOBAL_RAG_PROJECT_ID,
    delete_project_source,
    ingest_bytes_as_source,
    ingest_uploaded_files,
    is_global_scope,
    list_project_sources,
    reingest_project_source,
    replace_project_source,
)
from memory.text_embeddings import TextEmbedder


# Configuration
class Settings(BaseSettings):
    # Database
    postgres_host: str = "postgres"
    postgres_port: int = 5432
    postgres_user: str = "km_user"
    postgres_password: str
    postgres_db: str = "knowledge_manager"
    host_postgres_host: str = "localhost"
    host_postgres_port: int = 5432
    host_repo_root: str = "/home/mcarls/projects/ai-orchestrator"

    # Orchestrator
    log_level: str = "INFO"
    worker_threads: int = 4
    task_poll_interval: int = 5  # seconds
    task_queue_path: str = "/app/task_queue"
    require_queue_approval: bool = True

    # LLM Router
    llama_cpp_host: str = "host.docker.internal"
    llama_cpp_port: int = 8080

    class Config:
        env_file = ".env"
        case_sensitive = False


settings = Settings()

# Logging
logging.basicConfig(
    level=getattr(logging, settings.log_level),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


# Database connection pool
db_pool: asyncpg.Pool | None = None
memory_manager = MemoryManager()
code_embedder: CodeEmbedder | None = None
text_embedder: TextEmbedder | None = None
_reranker: "CrossEncoder | None" = None


AVAILABLE_MODELS = [
    {
        "id": "qwen/qwen3-30b-a3b",
        "label": "Qwen3-30B-A3B Q4_K_M (fits RTX 5090 VRAM)",
        "provider": "local-llm",
        "endpoint": "lmstudio",
        "capabilities": ["code", "analysis", "agentic"],
        "runtime": "local",
        "lmstudio_model": "qwen/qwen3-30b-a3b",
        "lmstudio_identifier": "qwen/qwen3-30b-a3b",
        "recommended_quant": "Q4_K_M",
        "gpu": "max",
        "context_length": 32768,
    },
    {
        "id": "qwen/qwen3-coder-next",
        "label": "Qwen3-Coder-Next 80B Q4_K_M (exceeds VRAM — slow first token)",
        "provider": "local-llm",
        "endpoint": "lmstudio",
        "capabilities": ["code", "analysis", "agentic"],
        "runtime": "local",
        "lmstudio_model": "qwen/qwen3-coder-next",
        "lmstudio_identifier": "qwen/qwen3-coder-next",
        "recommended_quant": "Q4_K_M",
        "gpu": "max",
        "context_length": 32768,
    },
    {
        "id": "claude-3-5-sonnet",
        "label": "Claude 3.5 Sonnet (Anthropic)",
        "provider": "anthropic",
        "capabilities": ["code", "analysis"],
        "runtime": "api",
    },
    {
        "id": "claude-3-opus",
        "label": "Claude 3 Opus (Anthropic)",
        "provider": "anthropic",
        "capabilities": ["analysis"],
        "runtime": "api",
    },
    {
        "id": "gpt-4.1-mini",
        "label": "GPT-4.1 Mini (OpenAI)",
        "provider": "openai",
        "capabilities": ["general"],
        "runtime": "api",
    },
    {
        "id": "lmstudio-local",
        "label": "LM Studio (Local Server)",
        "provider": "local-llm",
        "endpoint": "lmstudio",
        "capabilities": ["chat", "code"],
        "runtime": "local",
    },
]

TRACKING_STATUSES = {
    "not_tracked",
    "disabled",
    "pending",
    "indexing",
    "ready",
    "stale",
    "error",
}

CODE_CONTEXT_MAX_CHARS = 8000
CODE_CONTEXT_SNIPPET_CHARS = 1200
GLOBAL_TASK_PROJECT_ID = "00000000-0000-0000-0000-000000000000"
GLOBAL_RAG_PROJECT_NAME = "__global_rag__"
RUNTIME_SETTINGS_KEY = "runtime_controls"
MODEL_SET_KEY = "model_set"
EMBEDDING_JOB_TYPES = {
    "index_repo",
    "index_global_repo",
    "reindex_repo",
    "code_index",
    "text_index",
    "global_embedding",
}
DEFAULT_RUNTIME_SETTINGS = {
    "pause_all": False,
    "pause_local_models": False,
    "pause_embeddings": False,
    "auto_index_enabled": True,
    "gpu_utilization_limit": None,
    "gpu_memory_limit_mb": None,
}
DEFAULT_MODEL_SET = {
    "chat": "qwen/qwen3-30b-a3b",
    "coding": "qwen/qwen3-30b-a3b",
    "research": "qwen/qwen3-30b-a3b",
    "text_embedding": "BAAI/bge-base-en-v1.5",
    "code_embedding": "microsoft/codebert-base",
    "reranker": "cross-encoder/ms-marco-MiniLM-L-6-v2",
    "summarizer": "qwen/qwen3-30b-a3b",
}


def _worker_db_target(cli_preference: str) -> tuple[str, int]:
    if cli_preference == "local":
        return settings.host_postgres_host, settings.host_postgres_port
    return settings.postgres_host, settings.postgres_port


async def get_db_pool() -> asyncpg.Pool:
    """Get or create database connection pool"""
    global db_pool
    if db_pool is None:
        db_pool = await asyncpg.create_pool(
            host=settings.postgres_host,
            port=settings.postgres_port,
            user=settings.postgres_user,
            password=settings.postgres_password,
            database=settings.postgres_db,
            min_size=2,
            max_size=10
        )
    return db_pool


async def close_db_pool():
    """Close database connection pool"""
    global db_pool
    if db_pool is not None:
        await db_pool.close()
        db_pool = None


async def ensure_settings_schema(conn: asyncpg.Connection) -> None:
    """Ensure the orchestrator settings table exists."""
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS orchestrator_settings (
            key TEXT PRIMARY KEY,
            value JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        """
    )


async def ensure_project_tracking_schema(conn: asyncpg.Connection) -> None:
    """Create table to track project memory/embedding status."""
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS project_tracking (
            project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
            is_tracked BOOLEAN NOT NULL DEFAULT FALSE,
            repo_path TEXT,
            repo_paths TEXT,
            embedding_status TEXT NOT NULL DEFAULT 'not_tracked',
            embedding_last_indexed TIMESTAMPTZ,
            preferred_model_id TEXT,
            embedding_model_id TEXT,
            text_embedding_model_id TEXT,
            embedding_mode TEXT,
            global_embedding_status TEXT NOT NULL DEFAULT 'not_tracked',
            global_embedding_last_indexed TIMESTAMPTZ,
            global_embedding_mode TEXT,
            global_code_model_id TEXT,
            global_text_model_id TEXT,
            embedding_stats JSONB,
            global_embedding_stats JSONB,
            gpu_enabled BOOLEAN NOT NULL DEFAULT TRUE,
            gpu_device TEXT,
            embedding_enabled BOOLEAN NOT NULL DEFAULT TRUE,
            auto_index_enabled BOOLEAN NOT NULL DEFAULT TRUE,
            resource_profile_id TEXT,
            notes TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        """
    )
    await conn.execute(
        "ALTER TABLE project_tracking ADD COLUMN IF NOT EXISTS repo_paths TEXT;"
    )
    await conn.execute(
        "ALTER TABLE project_tracking ADD COLUMN IF NOT EXISTS text_embedding_model_id TEXT;"
    )
    await conn.execute(
        "ALTER TABLE project_tracking ADD COLUMN IF NOT EXISTS embedding_mode TEXT;"
    )
    await conn.execute(
        "ALTER TABLE project_tracking ADD COLUMN IF NOT EXISTS global_embedding_status TEXT NOT NULL DEFAULT 'not_tracked';"
    )
    await conn.execute(
        "ALTER TABLE project_tracking ADD COLUMN IF NOT EXISTS global_embedding_last_indexed TIMESTAMPTZ;"
    )
    await conn.execute(
        "ALTER TABLE project_tracking ADD COLUMN IF NOT EXISTS global_embedding_mode TEXT;"
    )
    await conn.execute(
        "ALTER TABLE project_tracking ADD COLUMN IF NOT EXISTS global_code_model_id TEXT;"
    )
    await conn.execute(
        "ALTER TABLE project_tracking ADD COLUMN IF NOT EXISTS global_text_model_id TEXT;"
    )
    await conn.execute(
        "ALTER TABLE project_tracking ADD COLUMN IF NOT EXISTS embedding_stats JSONB;"
    )
    await conn.execute(
        "ALTER TABLE project_tracking ADD COLUMN IF NOT EXISTS global_embedding_stats JSONB;"
    )
    await conn.execute(
        "ALTER TABLE project_tracking ADD COLUMN IF NOT EXISTS embedding_enabled BOOLEAN NOT NULL DEFAULT TRUE;"
    )
    await conn.execute(
        "ALTER TABLE project_tracking ADD COLUMN IF NOT EXISTS auto_index_enabled BOOLEAN NOT NULL DEFAULT TRUE;"
    )
    await conn.execute(
        "ALTER TABLE project_tracking ADD COLUMN IF NOT EXISTS resource_profile_id TEXT;"
    )


async def ensure_global_rag_project(conn: asyncpg.Connection) -> None:
    """Ensure the reserved hidden project used for global RAG uploads exists."""
    await conn.execute(
        """
        INSERT INTO projects (id, name, status)
        VALUES ($1, $2, 'active')
        ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name
        """,
        GLOBAL_RAG_PROJECT_ID,
        GLOBAL_RAG_PROJECT_NAME,
    )


async def get_orchestrator_setting(
    conn: asyncpg.Connection,
    key: str,
    default: Optional[dict] = None,
) -> Optional[dict]:
    """Fetch a JSON setting from the orchestrator settings table."""
    row = await conn.fetchrow(
        "SELECT value FROM orchestrator_settings WHERE key = $1",
        key,
    )
    if not row:
        return default
    value = row["value"]
    if isinstance(value, str):
        return json.loads(value)
    return value


async def set_orchestrator_setting(
    conn: asyncpg.Connection,
    key: str,
    value: dict,
) -> None:
    """Persist a JSON setting."""
    await conn.execute(
        """
        INSERT INTO orchestrator_settings (key, value, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (key)
        DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
        """,
        key,
        json.dumps(value),
    )


def resolve_model(model_id: str) -> Optional[dict]:
    """Return model definition for a given ID."""
    for model in AVAILABLE_MODELS:
        if model["id"] == model_id:
            return model
    return None


async def get_current_model_id(conn: asyncpg.Connection) -> str:
    """Return the currently selected model ID."""
    stored = await get_orchestrator_setting(conn, "current_model")
    model_id = stored.get("model_id") if stored else None
    if model_id and resolve_model(model_id):
        return model_id
    return AVAILABLE_MODELS[0]["id"]


def _merge_runtime_settings(value: Optional[dict]) -> dict:
    """Return runtime controls with defaults and normalized numeric limits."""
    merged = {**DEFAULT_RUNTIME_SETTINGS, **(value or {})}
    for key in ("gpu_utilization_limit", "gpu_memory_limit_mb"):
        if merged.get(key) in ("", 0):
            merged[key] = None
    return merged


async def get_runtime_settings(conn: asyncpg.Connection) -> dict:
    """Fetch persisted runtime controls."""
    value = await get_orchestrator_setting(conn, RUNTIME_SETTINGS_KEY, DEFAULT_RUNTIME_SETTINGS)
    return _merge_runtime_settings(value)


async def set_runtime_settings(conn: asyncpg.Connection, updates: dict) -> dict:
    """Merge and persist runtime controls."""
    current = await get_runtime_settings(conn)
    allowed = set(DEFAULT_RUNTIME_SETTINGS)
    clean_updates = {key: value for key, value in updates.items() if key in allowed}
    merged = _merge_runtime_settings({**current, **clean_updates})
    await set_orchestrator_setting(conn, RUNTIME_SETTINGS_KEY, merged)
    return merged


async def get_model_set(conn: asyncpg.Connection) -> dict:
    """Fetch model role assignments."""
    value = await get_orchestrator_setting(conn, MODEL_SET_KEY, DEFAULT_MODEL_SET)
    return {**DEFAULT_MODEL_SET, **(value or {})}


async def set_model_set(conn: asyncpg.Connection, updates: dict) -> dict:
    """Merge and persist model role assignments."""
    current = await get_model_set(conn)
    allowed = set(DEFAULT_MODEL_SET)
    clean_updates = {key: value for key, value in updates.items() if key in allowed and value}
    merged = {**current, **clean_updates}
    await set_orchestrator_setting(conn, MODEL_SET_KEY, merged)
    return merged


async def bootstrap_memory_and_settings() -> None:
    """Initialise memory schema and orchestrator settings."""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await initialize_schema(conn)
        await ensure_settings_schema(conn)
        await ensure_project_tracking_schema(conn)
        await ensure_global_rag_project(conn)
        # Ensure a default model record exists
        current_model = await get_orchestrator_setting(conn, "current_model")
        if not current_model:
            await set_orchestrator_setting(
                conn,
                "current_model",
                {"model_id": AVAILABLE_MODELS[0]["id"]},
            )
        if not await get_orchestrator_setting(conn, RUNTIME_SETTINGS_KEY):
            await set_orchestrator_setting(conn, RUNTIME_SETTINGS_KEY, DEFAULT_RUNTIME_SETTINGS)
        if not await get_orchestrator_setting(conn, MODEL_SET_KEY):
            await set_orchestrator_setting(conn, MODEL_SET_KEY, DEFAULT_MODEL_SET)
    async with pool.acquire() as conn:
        await register_model(conn, model_id="BAAI/bge-base-en-v1.5", purpose="text", dimensions=768, framework="sentence-transformers", is_default=True)
        await register_model(conn, model_id="microsoft/codebert-base", purpose="code", dimensions=768, framework="sentence-transformers", is_default=True)
        await register_model(conn, model_id="cross-encoder/ms-marco-MiniLM-L-6-v2", purpose="rerank", dimensions=0, framework="sentence-transformers", is_default=True)


def get_code_embedder() -> CodeEmbedder:
    """Load the code embedding model lazily for query embeddings."""
    global code_embedder
    if code_embedder is None:
        code_embedder = CodeEmbedder()
    return code_embedder


def get_text_embedder() -> TextEmbedder:
    """Load the text embedding model lazily for memory operations."""
    global text_embedder
    if text_embedder is None:
        text_embedder = TextEmbedder()
    return text_embedder


def get_reranker() -> "CrossEncoder":
    """Return the CrossEncoder reranker singleton, loading on first call."""
    global _reranker
    if _reranker is None:
        from sentence_transformers import CrossEncoder
        _reranker = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")
    return _reranker


def _truncate_snippet(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "\n... [truncated]\n"


def _build_code_context_text(entries: list[dict]) -> str:
    if not entries:
        return ""
    lines = ["", "Relevant code context:"]
    remaining = CODE_CONTEXT_MAX_CHARS
    for entry in entries:
        header = f"{entry['file_path']}:{entry['start_line']}-{entry['end_line']} ({entry['symbol_name']})"
        snippet = _truncate_snippet(entry["snippet"], CODE_CONTEXT_SNIPPET_CHARS)
        block = f"\n{header}\n```\n{snippet}\n```"
        if len(block) > remaining:
            break
        lines.append(block)
        remaining -= len(block)
    return "\n".join(lines) + "\n"


async def _attach_code_context(task_data: dict) -> dict:
    context = task_data.get("context") or {}
    job_type = context.get("job_type")
    if job_type in {"index_repo", "index_global_repo", "code_index"}:
        return {}
    project_id = task_data.get("project_id")
    description = task_data.get("description") or ""
    if not project_id or not description.strip():
        return {}

    pool = await get_db_pool()
    embedder = get_code_embedder()
    query_embedding = embedder.embed_query(description)

    async with pool.acquire() as conn:
        results = await search_code(conn, project_id, query_embedding, top_k=8)

    if not results:
        return {}

    context_entries = []
    for row in results:
        snippet = row["content"]
        context_entries.append(
            {
                "file_path": row["file_path"],
                "symbol_name": row["symbol_name"],
                "chunk_type": row["chunk_type"],
                "start_line": row["start_line"],
                "end_line": row["end_line"],
                "similarity": float(row["similarity"]),
                "snippet": snippet,
            }
        )

    context_text = _build_code_context_text(context_entries)
    return {
        "code_context": context_entries,
        "description": description + context_text,
    }


def normalise_tracking_record(project_id: str, row: Optional[asyncpg.Record]) -> dict:
    """Build a serialisable tracking record."""
    base = {
        "project_id": str(project_id),
        "is_tracked": False,
        "repo_path": None,
        "repo_paths": [],
        "embedding_status": "not_tracked",
        "embedding_last_indexed": None,
        "preferred_model_id": None,
        "embedding_model_id": None,
        "text_embedding_model_id": None,
        "embedding_mode": None,
        "global_embedding_status": "not_tracked",
        "global_embedding_last_indexed": None,
        "global_embedding_mode": None,
        "global_code_model_id": None,
        "global_text_model_id": None,
        "embedding_stats": None,
        "global_embedding_stats": None,
        "gpu_enabled": True,
        "gpu_device": None,
        "embedding_enabled": True,
        "auto_index_enabled": True,
        "resource_profile_id": None,
        "notes": None,
    }
    if row:
        data = dict(row)
        repo_paths_raw = data.pop("repo_paths", None)
        repo_paths = []
        if repo_paths_raw:
            repo_paths = [path.strip() for path in repo_paths_raw.splitlines() if path and path.strip()]
        data["repo_paths"] = repo_paths
        if not data.get("repo_path") and repo_paths:
            data["repo_path"] = repo_paths[0]
        data["project_id"] = str(project_id)
        return {**base, **data}
    return base


async def fetch_project_tracking(conn: asyncpg.Connection, project_id: str) -> dict:
    """Return tracking metadata for a project."""
    row = await conn.fetchrow(
        """
        SELECT
            is_tracked,
            repo_path,
            repo_paths,
            embedding_status,
            embedding_last_indexed,
            preferred_model_id,
            embedding_model_id,
            text_embedding_model_id,
            embedding_mode,
            global_embedding_status,
            global_embedding_last_indexed,
            global_embedding_mode,
            global_code_model_id,
            global_text_model_id,
            embedding_stats,
            global_embedding_stats,
            gpu_enabled,
            gpu_device,
            embedding_enabled,
            auto_index_enabled,
            resource_profile_id,
            notes
        FROM project_tracking
        WHERE project_id = $1
        """,
        project_id,
    )
    return normalise_tracking_record(project_id, row)


def validate_model_choice(model_id: Optional[str]) -> Optional[str]:
    """Ensure requested model exists."""
    if not model_id:
        return None
    model = resolve_model(model_id)
    if not model:
        raise HTTPException(status_code=404, detail=f"Unknown model id '{model_id}'")
    return model["id"]


def normalize_embedding_model_id(model_id: Optional[str]) -> Optional[str]:
    if not model_id:
        return None
    value = model_id.strip()
    return value or None


def derive_project_name(repo_path: Optional[str], explicit_name: Optional[str]) -> str:
    """Derive a stable project name from caller input."""
    if explicit_name and explicit_name.strip():
        return explicit_name.strip()
    if repo_path and repo_path.strip():
        path = Path(repo_path).expanduser()
        return path.name or path.resolve(strict=False).name or "untitled-project"
    raise HTTPException(status_code=400, detail="Project name is required when repo_path is omitted")


async def ensure_project_exists(conn: asyncpg.Connection, project_id: str) -> None:
    """Raise if requested project does not exist."""
    exists = await conn.fetchval("SELECT 1 FROM projects WHERE id = $1", project_id)
    if not exists:
        raise HTTPException(status_code=404, detail="Project not found")


async def upsert_project_tracking(
    conn: asyncpg.Connection,
    project_id: str,
    data: "ProjectTrackingUpdate",
) -> dict:
    """Merge tracking metadata updates and persist."""
    await ensure_project_exists(conn, project_id)
    current = await fetch_project_tracking(conn, project_id)

    repo_path = data.repo_path if data.repo_path is not None else current["repo_path"]
    if repo_path:
        repo_path = repo_path.strip()

    if data.repo_paths is not None:
        repo_paths_list = [path.strip() for path in data.repo_paths if path and path.strip()]
    else:
        repo_paths_list = list(current.get("repo_paths") or [])
    # Ensure repo_path is in sync with list
    if repo_path:
        repo_paths_list = [repo_path] + [p for p in repo_paths_list if p != repo_path]
    elif repo_paths_list:
        repo_path = repo_paths_list[0]

    repo_paths_text = "\n".join(repo_paths_list) if repo_paths_list else None

    is_tracked = data.is_tracked if data.is_tracked is not None else current["is_tracked"]

    embedding_status = data.embedding_status or current["embedding_status"]
    if embedding_status not in TRACKING_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid embedding status '{embedding_status}'",
        )

    if is_tracked and not repo_path:
        raise HTTPException(
            status_code=400,
            detail="Tracked projects must specify at least one repository path",
        )

    if not is_tracked:
        embedding_status = "not_tracked"

    preferred_model_id = validate_model_choice(
        data.preferred_model_id or current["preferred_model_id"]
    )
    embedding_model_id = normalize_embedding_model_id(
        data.embedding_model_id or current["embedding_model_id"]
    )
    text_embedding_model_id = normalize_embedding_model_id(
        data.text_embedding_model_id or current.get("text_embedding_model_id")
    )
    embedding_mode = data.embedding_mode or current.get("embedding_mode")

    global_embedding_status = data.global_embedding_status or current["global_embedding_status"]
    if global_embedding_status not in TRACKING_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid global embedding status '{global_embedding_status}'",
        )
    global_embedding_mode = data.global_embedding_mode or current.get("global_embedding_mode")
    global_code_model_id = normalize_embedding_model_id(
        data.global_code_model_id or current.get("global_code_model_id")
    )
    global_text_model_id = normalize_embedding_model_id(
        data.global_text_model_id or current.get("global_text_model_id")
    )
    embedding_stats = data.embedding_stats if data.embedding_stats is not None else current.get("embedding_stats")
    global_embedding_stats = (
        data.global_embedding_stats if data.global_embedding_stats is not None else current.get("global_embedding_stats")
    )

    gpu_enabled = (
        data.gpu_enabled if data.gpu_enabled is not None else current["gpu_enabled"]
    )
    gpu_device = data.gpu_device if data.gpu_device is not None else current["gpu_device"]
    embedding_enabled = (
        data.embedding_enabled if data.embedding_enabled is not None else current["embedding_enabled"]
    )
    auto_index_enabled = (
        data.auto_index_enabled if data.auto_index_enabled is not None else current["auto_index_enabled"]
    )
    resource_profile_id = (
        data.resource_profile_id if data.resource_profile_id is not None else current["resource_profile_id"]
    )
    notes = data.notes if data.notes is not None else current["notes"]

    if is_tracked and not embedding_enabled:
        embedding_status = "disabled"

    await conn.execute(
        """
        INSERT INTO project_tracking (
            project_id,
            is_tracked,
            repo_path,
            repo_paths,
            embedding_status,
            embedding_last_indexed,
            preferred_model_id,
            embedding_model_id,
            text_embedding_model_id,
            embedding_mode,
            global_embedding_status,
            global_embedding_last_indexed,
            global_embedding_mode,
            global_code_model_id,
            global_text_model_id,
            embedding_stats,
            global_embedding_stats,
            gpu_enabled,
            gpu_device,
            embedding_enabled,
            auto_index_enabled,
            resource_profile_id,
            notes,
            updated_at
        ) VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            CASE WHEN $5 = 'ready' THEN NOW() ELSE $6 END,
            $7,
            $8,
            $9,
            $10,
            $11,
            CASE WHEN $11 = 'ready' THEN NOW() ELSE $12 END,
            $13,
            $14,
            $15,
            $16,
            $17,
            $18,
            $19,
            $20,
            $21,
            $22,
            $23,
            NOW()
        )
        ON CONFLICT (project_id)
        DO UPDATE SET
            is_tracked = EXCLUDED.is_tracked,
            repo_path = EXCLUDED.repo_path,
            repo_paths = EXCLUDED.repo_paths,
            embedding_status = EXCLUDED.embedding_status,
            embedding_last_indexed = CASE
                WHEN EXCLUDED.embedding_status = 'ready' THEN NOW()
                ELSE project_tracking.embedding_last_indexed
            END,
            preferred_model_id = EXCLUDED.preferred_model_id,
            embedding_model_id = EXCLUDED.embedding_model_id,
            text_embedding_model_id = EXCLUDED.text_embedding_model_id,
            embedding_mode = EXCLUDED.embedding_mode,
            global_embedding_status = EXCLUDED.global_embedding_status,
            global_embedding_last_indexed = CASE
                WHEN EXCLUDED.global_embedding_status = 'ready' THEN NOW()
                ELSE project_tracking.global_embedding_last_indexed
            END,
            global_embedding_mode = EXCLUDED.global_embedding_mode,
            global_code_model_id = EXCLUDED.global_code_model_id,
            global_text_model_id = EXCLUDED.global_text_model_id,
            embedding_stats = EXCLUDED.embedding_stats,
            global_embedding_stats = EXCLUDED.global_embedding_stats,
            gpu_enabled = EXCLUDED.gpu_enabled,
            gpu_device = EXCLUDED.gpu_device,
            embedding_enabled = EXCLUDED.embedding_enabled,
            auto_index_enabled = EXCLUDED.auto_index_enabled,
            resource_profile_id = EXCLUDED.resource_profile_id,
            notes = EXCLUDED.notes,
            updated_at = NOW()
        """,
        project_id,
        is_tracked,
        repo_path,
        repo_paths_text,
        embedding_status,
        current["embedding_last_indexed"],
        preferred_model_id,
        embedding_model_id,
        text_embedding_model_id,
        embedding_mode,
        global_embedding_status,
        current.get("global_embedding_last_indexed"),
        global_embedding_mode,
        global_code_model_id,
        global_text_model_id,
        embedding_stats,
        global_embedding_stats,
        gpu_enabled,
        gpu_device,
        embedding_enabled,
        auto_index_enabled,
        resource_profile_id,
        notes,
    )

    return await fetch_project_tracking(conn, project_id)



# LISTEN/NOTIFY handler
async def listen_for_task_updates():
    """Subscribe to PostgreSQL LISTEN/NOTIFY for real-time task updates"""
    pool = await get_db_pool()

    async with pool.acquire() as conn:
        logger.info("Subscribing to task_updates channel...")

        async def notification_handler(connection, pid, channel, payload):
            logger.info(f"Received notification on {channel}: {payload}")
            # TODO: Process task update
            # - Parse JSON payload
            # - Determine if action needed
            # - Dispatch to appropriate worker

        await conn.add_listener('task_updates', notification_handler)

        # Keep connection alive to receive notifications
        try:
            while True:
                await asyncio.sleep(1)
        except asyncio.CancelledError:
            await conn.remove_listener('task_updates', notification_handler)
            raise


# Task Queue integration
import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent))
from shared.task_queue import TaskPriority, TaskQueue, TaskStatus
import subprocess


# Task processing
def _task_job_type(task_data: dict) -> Optional[str]:
    return ((task_data.get("context") or {}).get("job_type") or "").strip() or None


def _is_embedding_task(task_data: dict) -> bool:
    return _task_job_type(task_data) in EMBEDDING_JOB_TYPES


def _has_active_embedding_job(task_queue: TaskQueue) -> bool:
    for status in (TaskStatus.ASSIGNED, TaskStatus.IN_PROGRESS):
        for task in task_queue.list_tasks(status):
            if task.get("cli_preference") == "local" and _is_embedding_task(task):
                return True
    return False


def _defer_reason(task_data: dict, runtime_settings: dict, active_embedding_job: bool) -> Optional[str]:
    if runtime_settings.get("pause_all"):
        return "all task assignment is paused"
    if task_data.get("cli_preference") == "local" and runtime_settings.get("pause_local_models"):
        return "local model tasks are paused"
    if _is_embedding_task(task_data):
        if runtime_settings.get("pause_embeddings"):
            return "embedding tasks are paused"
        if active_embedding_job:
            return "another embedding task is already active"
    return None


def _promote_queued_embedding_tasks(project_id: str) -> int:
    """Raise queued embedding work for a project to highest priority."""
    task_queue = TaskQueue(queue_path=settings.task_queue_path)
    promoted = 0
    for task in task_queue.list_tasks(TaskStatus.QUEUED):
        if task.get("project_id") != project_id or not _is_embedding_task(task):
            continue
        if int(task.get("priority", TaskPriority.NORMAL)) >= TaskPriority.HIGHEST:
            continue
        task_queue.update_priority(task["task_id"], TaskPriority.HIGHEST)
        promoted += 1
    return promoted


async def _promote_embeddings_if_project_requested(project_id: str) -> None:
    """Promote queued indexing when a project is actively queried before readiness."""
    try:
        pool = await get_db_pool()
        async with pool.acquire() as conn:
            tracking = await fetch_project_tracking(conn, project_id)
        if (
            tracking.get("embedding_enabled", True)
            and tracking.get("embedding_status") in {"pending", "stale", "not_tracked", "error"}
        ):
            promoted = _promote_queued_embedding_tasks(project_id)
            if promoted:
                logger.info("Promoted %s queued embedding task(s) for requested project %s", promoted, project_id)
    except Exception:
        logger.debug("Unable to promote embedding task for requested project %s", project_id, exc_info=True)


async def process_pending_tasks():
    """Poll task queue filesystem and dispatch to CLI workers"""
    task_queue = TaskQueue(queue_path=settings.task_queue_path)
    logger.info("Task processor started - polling task queue...")

    def get_project_cli_locks() -> dict[str, str]:
        """Return mapping of project_id -> cli (e.g., 'claude')."""
        locks: dict[str, str] = {}
        for status in (TaskStatus.ASSIGNED, TaskStatus.IN_PROGRESS):
            active_tasks = task_queue.list_tasks(status)
            for task in active_tasks:
                project_id = task.get("project_id")
                if not project_id:
                    continue
                cli_name = task.get("cli_preference")
                assigned_to = task.get("assigned_to", "")
                if assigned_to and assigned_to.endswith("-worker"):
                    cli_name = assigned_to.rsplit("-worker", 1)[0]
                if cli_name:
                    locks[project_id] = cli_name
        return locks

    while True:
        try:
            pool = await get_db_pool()
            async with pool.acquire() as conn:
                runtime_settings = await get_runtime_settings(conn)

            # Get queued tasks
            queued_tasks = task_queue.list_tasks(TaskStatus.QUEUED, limit=10)
            project_locks = get_project_cli_locks()
            active_embedding_job = _has_active_embedding_job(task_queue)

            if queued_tasks:
                logger.info(f"Found {len(queued_tasks)} queued tasks")

                for task_data in queued_tasks:
                    task_id = task_data['task_id']
                    cli_preference = task_data.get('cli_preference', 'claude')
                    project_id = task_data.get('project_id')
                    approval_meta = (task_data.get("context") or {}).get("approval") or {}
                    is_approved = bool(approval_meta.get("approved"))
                    approved_by = (approval_meta.get("approved_by") or "").strip()

                    if settings.require_queue_approval and (not is_approved or not approved_by):
                        logger.warning(
                            "Rejecting unapproved task %s (approval metadata missing).",
                            task_id[:8],
                        )
                        task_queue.fail_task(
                            task_id,
                            error={
                                "type": "ApprovalRequired",
                                "message": "Task lacks explicit approval metadata.",
                            },
                            exit_code=1,
                        )
                        continue

                    defer_reason = _defer_reason(task_data, runtime_settings, active_embedding_job)
                    if defer_reason:
                        logger.info("Deferring task %s: %s", task_id[:8], defer_reason)
                        continue

                    if project_id and project_locks.get(project_id):
                        cli_preference = project_locks[project_id]
                    elif project_id and cli_preference:
                        project_locks[project_id] = cli_preference

                    logger.info(f"Assigning task {task_id[:8]} to {cli_preference}")

                    task_data['cli_preference'] = cli_preference

                    extra_updates = await _attach_code_context(task_data)
                    if extra_updates:
                        task_data.update(extra_updates)

                    # Assign task
                    success = task_queue.assign_task(
                        task_id,
                        assigned_to=f"{cli_preference}-worker",
                        worker_pid=None,  # Will be set by worker
                        extra_updates=extra_updates if extra_updates else None,
                    )

                    if success:
                        if cli_preference == "local" and _is_embedding_task(task_data):
                            active_embedding_job = True
                        # Spawn CLI worker (background process)
                        await spawn_cli_worker(task_queue, task_data, cli_preference)
                    else:
                        logger.warning(f"Failed to assign task {task_id[:8]}")

        except Exception as e:
            logger.error(f"Error processing tasks: {e}", exc_info=True)

        await asyncio.sleep(settings.task_poll_interval)


async def spawn_cli_worker(task_queue: TaskQueue, task_data: dict, cli_type: str):
    """Spawn a CLI worker process to execute the task"""
    task_id = task_data['task_id']
    description = task_data.get('description', '')
    if cli_type == "local":
        logger.info(
            "Local task %s queued; expecting host-side local worker to pick it up.",
            task_id[:8],
        )
        return

    # Create worker script path
    worker_script = Path(__file__).parent.parent.parent / "cli_integrations" / f"{cli_type}_worker.sh"

    if not worker_script.exists():
        logger.warning(f"Worker script not found: {worker_script}")
        logger.info(f"Creating placeholder worker for {cli_type}")
        task_queue.fail_task(
            task_id,
            error={"type": "WorkerMissing", "message": f"Worker {cli_type} not available"},
            exit_code=1,
        )
        return

    try:
        # Spawn worker process in background
        process = await asyncio.create_subprocess_exec(
            str(worker_script),
            task_id,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )

        logger.info(f"Spawned {cli_type} worker (PID: {process.pid}) for task {task_id[:8]}")

        # Don't wait - let it run in background
        # Worker will update task status on its own

    except Exception as e:
        logger.error(f"Failed to spawn worker for task {task_id[:8]}: {e}")
        # Mark task as failed
        task_queue.fail_task(
            task_id,
            error={"type": "WorkerSpawnError", "message": str(e)},
            exit_code=1
        )


# FastAPI application
@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator:
    """Manage application lifecycle"""
    logger.info("Starting AI Orchestrator...")

    # Initialize database pool
    await get_db_pool()
    logger.info("Database connection pool created")

    # Ensure memory schema + settings exist
    await bootstrap_memory_and_settings()
    logger.info("Memory schema verified and orchestrator settings ready")

    # Start background tasks
    listener_task = asyncio.create_task(listen_for_task_updates())
    processor_task = asyncio.create_task(process_pending_tasks())

    yield

    # Shutdown
    logger.info("Shutting down AI Orchestrator...")
    listener_task.cancel()
    processor_task.cancel()
    await close_db_pool()


app = FastAPI(
    title="AI Orchestrator",
    description="Task dispatcher and coordinator for multi-agent system",
    version="0.1.0",
    lifespan=lifespan
)


# API Models
class TaskCreate(BaseModel):
    title: str
    project_id: str | None = None
    priority: int = 3
    details: str | None = None


class TaskResponse(BaseModel):
    id: str
    title: str
    status: str
    project_id: str | None
    priority: int | None


class MemoryFeedbackRequest(BaseModel):
    memory_id: str
    feedback: int = Field(ge=-5, le=5)


class MemorySearchRequest(BaseModel):
    embedding: List[float]
    project_id: Optional[str] = None
    system_id: Optional[str] = None
    task_id: Optional[str] = None
    categories: Optional[List[str]] = None
    top_k: int = Field(default=5, ge=1, le=50)


class MemorySearchTextRequest(BaseModel):
    query: str
    project_id: Optional[str] = None
    system_id: Optional[str] = None
    task_id: Optional[str] = None
    categories: Optional[List[str]] = None
    top_k: int = Field(default=8, ge=1, le=50)


class MemoryAddRequest(BaseModel):
    content: str
    project_id: Optional[str] = None
    task_id: Optional[str] = None
    system_id: Optional[str] = None
    created_by: Optional[str] = "koweb"
    categories: Optional[List[str]] = None


class CodeSearchRequest(BaseModel):
    query: str
    top_k: int = Field(default=8, ge=1, le=50)


class CodeIndexRequest(BaseModel):
    repo_path: Optional[str] = None
    force_reindex: bool = False
    model_id: Optional[str] = None
    approved: bool = False
    approved_by: Optional[str] = None


class TextSearchRequest(BaseModel):
    query: str
    top_k: int = 10
    use_reranker: bool = True
    table: str = "text_chunks"


class TextIndexRequest(BaseModel):
    repo_path: str
    mode: str = "text"
    target: str = "project"
    force_reindex: bool = False
    include_pdfs: bool = True
    approved: bool = False
    approved_by: Optional[str] = None


class IngestTextRequest(BaseModel):
    content: str
    source_label: str = "api_direct"


class TextChunkResponse(BaseModel):
    id: int
    file_path: str
    chunk_index: int
    chunk_type: str
    header_context: str
    content: str
    source_type: str
    source_id: str | None = None
    source_label: str | None = None
    original_filename: str | None = None
    mime_type: str | None = None
    ingest_method: str | None = None
    similarity: float | None = None
    rrf_score: float | None = None
    rerank_score: float | None = None


class ManualTaskCreate(BaseModel):
    project_id: str
    title: str
    description: str
    cli_preference: str = "claude"
    priority: int = Field(default=3, ge=1, le=5)
    working_dir: Optional[str] = None
    approved: bool = False
    approved_by: Optional[str] = None


class RuntimeSettingsUpdate(BaseModel):
    pause_all: Optional[bool] = None
    pause_local_models: Optional[bool] = None
    pause_embeddings: Optional[bool] = None
    auto_index_enabled: Optional[bool] = None
    gpu_utilization_limit: Optional[int] = Field(default=None, ge=1, le=100)
    gpu_memory_limit_mb: Optional[int] = Field(default=None, ge=1)


class TaskPriorityUpdate(BaseModel):
    priority: int = Field(ge=1, le=5)


class TaskCancelRequest(BaseModel):
    reason: str = "Cancelled by operator"
    cancelled_by: str = "operator"


class ModelSetUpdate(BaseModel):
    chat: Optional[str] = None
    coding: Optional[str] = None
    research: Optional[str] = None
    text_embedding: Optional[str] = None
    code_embedding: Optional[str] = None
    reranker: Optional[str] = None
    summarizer: Optional[str] = None


class ModelSelectionRequest(BaseModel):
    model_id: str


class ProjectCreate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    repo_path: Optional[str] = None
    gpu_enabled: bool = True
    gpu_device: Optional[str] = None
    embedding_enabled: bool = True
    auto_index_enabled: bool = True
    resource_profile_id: Optional[str] = None
    notes: Optional[str] = None
    approved: bool = False
    approved_by: Optional[str] = None


class ProjectTrackingUpdate(BaseModel):
    repo_path: Optional[str] = None
    repo_paths: Optional[List[str]] = None
    is_tracked: Optional[bool] = None
    embedding_status: Optional[str] = None
    preferred_model_id: Optional[str] = None
    embedding_model_id: Optional[str] = None
    text_embedding_model_id: Optional[str] = None
    embedding_mode: Optional[str] = None
    global_embedding_status: Optional[str] = None
    global_embedding_last_indexed: Optional[str] = None
    global_embedding_mode: Optional[str] = None
    global_code_model_id: Optional[str] = None
    global_text_model_id: Optional[str] = None
    embedding_stats: Optional[dict] = None
    global_embedding_stats: Optional[dict] = None
    gpu_enabled: Optional[bool] = None
    gpu_device: Optional[str] = None
    embedding_enabled: Optional[bool] = None
    auto_index_enabled: Optional[bool] = None
    resource_profile_id: Optional[str] = None
    notes: Optional[str] = None


class EmbeddingJobRequest(BaseModel):
    mode: Literal["auto", "code", "text"] = "auto"
    target: Literal["project", "global", "both"] = "project"
    code_model_id: Optional[str] = None
    text_model_id: Optional[str] = None
    force_reindex: bool = False
    approved: bool = False
    approved_by: Optional[str] = None


class GlobalEmbeddingRequest(BaseModel):
    repo_path: Optional[str] = None
    repo_paths: Optional[List[str]] = None
    mode: Literal["auto", "code", "text"] = "auto"
    code_model_id: Optional[str] = None
    text_model_id: Optional[str] = None
    force_reindex: bool = False
    approved: bool = False
    approved_by: Optional[str] = None


def _require_explicit_approval(approved: bool, approved_by: Optional[str], action: str) -> dict:
    if not settings.require_queue_approval:
        return {"approved": True, "approved_by": approved_by or "approval-gate-disabled"}
    approver = (approved_by or "").strip()
    if not approved or not approver:
        raise HTTPException(
            status_code=403,
            detail=(
                f"Queue approval required for {action}. "
                "Resubmit with approved=true and approved_by='<human-id>'."
            ),
        )
    return {"approved": True, "approved_by": approver}


async def _queue_embedding_job(project_id: str, payload: EmbeddingJobRequest, approval: dict) -> dict:
    """Create a filesystem task for project/global embedding work."""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await ensure_project_exists(conn, project_id)
        tracking = await fetch_project_tracking(conn, project_id)
        project = await conn.fetchrow(
            "SELECT name FROM projects WHERE id = $1",
            project_id,
        )

    if not tracking.get("embedding_enabled", True):
        raise HTTPException(status_code=400, detail="Project embeddings are disabled")

    repo_paths = tracking.get("repo_paths") or []
    if tracking.get("repo_path") and not repo_paths:
        repo_paths = [tracking["repo_path"]]

    if not tracking["is_tracked"] or not repo_paths:
        raise HTTPException(
            status_code=400,
            detail="Project must be tracked with a repository path before indexing",
        )

    code_model_id = (
        normalize_embedding_model_id(payload.code_model_id)
        or tracking.get("embedding_model_id")
        or DEFAULT_MODEL_SET["code_embedding"]
    )
    text_model_id = (
        normalize_embedding_model_id(payload.text_model_id)
        or tracking.get("text_embedding_model_id")
        or DEFAULT_MODEL_SET["text_embedding"]
    )

    status_payload = ProjectTrackingUpdate()
    if payload.target in {"project", "both"}:
        status_payload.embedding_status = "indexing"
        status_payload.embedding_model_id = code_model_id
        status_payload.text_embedding_model_id = text_model_id
        status_payload.embedding_mode = payload.mode
    if payload.target in {"global", "both"}:
        status_payload.global_embedding_status = "indexing"
        status_payload.global_code_model_id = code_model_id
        status_payload.global_text_model_id = text_model_id
        status_payload.global_embedding_mode = payload.mode
    if status_payload.model_dump(exclude_none=True):
        async with pool.acquire() as conn:
            await upsert_project_tracking(conn, project_id, status_payload)

    project_name = project["name"] if project else project_id
    repo_path = repo_paths[0]
    task_queue = TaskQueue(queue_path=settings.task_queue_path)
    db_host, db_port = _worker_db_target("local")
    embeddings_script = Path(settings.host_repo_root) / "memory" / "run_embeddings.py"
    base_command = (
        f"python \"{embeddings_script}\""
        f" --project-id {project_id}"
        f" --mode {payload.mode}"
        f" --target {payload.target}"
        f" --code-model \"{code_model_id}\""
        f" --text-model \"{text_model_id}\""
        f" --db-host \"{db_host}\""
        f" --db-port {db_port}"
        f" --db-name \"{settings.postgres_db}\""
        f" --db-user \"{settings.postgres_user}\""
        f" --db-password \"{settings.postgres_password}\""
    )
    if payload.force_reindex:
        base_command += " --force-reindex"

    commands = "\n".join(f"{base_command} --repo-path \"{path}\"" for path in repo_paths)
    repo_paths_display = "\n".join(f"- {path}" for path in repo_paths)
    description = (
        "Run repository embedding for the selected project.\n"
        f"Project: {project_name} ({project_id})\n"
        f"Repository paths:\n{repo_paths_display}\n"
        f"Mode: {payload.mode}\n"
        f"Target: {payload.target}\n"
        "Command hint:\n"
        f"{commands}"
    )
    context = {
        "job_type": "index_repo",
        "mode": payload.mode,
        "target": payload.target,
        "repo_path": repo_path,
        "repo_paths": repo_paths,
        "code_model_id": code_model_id,
        "text_model_id": text_model_id,
        "force_reindex": payload.force_reindex,
        "command": "set -e\n" + commands,
        "approval": approval,
    }

    task_id = task_queue.create_task(
        project_id=project_id,
        task_title=f"Embed repository - {project_name}",
        description=description,
        priority=TaskPriority.HIGH,
        cli_preference="local",
        working_dir=settings.host_repo_root,
        context=context,
    )

    return {
        "status": "queued",
        "task_id": task_id,
        "priority": int(TaskPriority.HIGH),
        "mode": payload.mode,
        "target": payload.target,
        "repo_paths": repo_paths,
        "embedding_status": "indexing" if payload.target in {"project", "both"} else tracking["embedding_status"],
    }


# API Endpoints
@app.get("/")
async def root():
    """Root endpoint"""
    return {
        "name": "AI Orchestrator",
        "version": "0.1.0",
        "status": "running"
    }


@app.get("/health")
async def health():
    """Health check endpoint"""
    try:
        pool = await get_db_pool()
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        return {"status": "healthy", "database": "connected"}
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Unhealthy: {str(e)}")


@app.get("/tasks", response_model=list[TaskResponse])
async def get_tasks(status: str | None = None, limit: int = 100):
    """Get tasks from database"""
    pool = await get_db_pool()

    query = """
        SELECT id, title, status, project_id, priority
        FROM tasks
    """

    if status:
        query += f" WHERE status = '{status}'"

    query += f" ORDER BY created_at DESC LIMIT {limit}"

    async with pool.acquire() as conn:
        tasks = await conn.fetch(query)

    return [dict(task) for task in tasks]


@app.post("/tasks/queue")
async def queue_manual_task(payload: ManualTaskCreate):
    """Create a filesystem queue entry so a CLI worker can pick it up."""
    approval = _require_explicit_approval(
        payload.approved,
        payload.approved_by,
        action="manual task queueing",
    )
    task_queue = TaskQueue(queue_path=settings.task_queue_path)
    try:
        task_id = task_queue.create_task(
            project_id=payload.project_id,
            task_title=payload.title,
            description=payload.description,
            priority=payload.priority,
            cli_preference=payload.cli_preference,
            working_dir=payload.working_dir,
            context={"approval": approval},
        )
    except Exception as exc:
        logger.error("Failed to queue manual task", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Unable to queue task: {exc}") from exc

    return {"task_id": task_id}


@app.post("/tasks/{task_id}/priority")
async def update_task_priority(task_id: str, payload: TaskPriorityUpdate):
    """Update queued/assigned/in-progress filesystem task priority."""
    task_queue = TaskQueue(queue_path=settings.task_queue_path)
    updated = task_queue.update_priority(task_id, payload.priority)
    if not updated:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"status": "updated", "task_id": task_id, "priority": updated.get("priority")}


@app.post("/tasks/{task_id}/cancel")
async def cancel_task(task_id: str, payload: TaskCancelRequest):
    """Cancel a filesystem queue task."""
    task_queue = TaskQueue(queue_path=settings.task_queue_path)
    cancelled = task_queue.cancel_task(
        task_id,
        reason=payload.reason,
        cancelled_by=payload.cancelled_by,
    )
    if not cancelled:
        raise HTTPException(status_code=404, detail="Task not found or already finished")
    return {"status": "cancelled", "task_id": task_id}


@app.post("/tasks/local/cancel-all")
async def cancel_all_local_tasks(payload: TaskCancelRequest):
    """Cancel queued/assigned/in-progress local high-resource jobs."""
    task_queue = TaskQueue(queue_path=settings.task_queue_path)
    cancelled = task_queue.cancel_matching(
        cli_preference="local",
        reason=payload.reason,
        cancelled_by=payload.cancelled_by,
    )
    return {"status": "cancelled", "count": len(cancelled), "task_ids": [task["task_id"] for task in cancelled]}


@app.get("/settings/runtime")
async def read_runtime_settings():
    """Return runtime pause and resource-limit controls."""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        return await get_runtime_settings(conn)


@app.post("/settings/runtime")
async def update_runtime_settings(payload: RuntimeSettingsUpdate):
    """Update runtime pause and resource-limit controls."""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        return await set_runtime_settings(conn, payload.model_dump(exclude_unset=True))


@app.get("/config/model-set")
async def read_model_set():
    """Return role-based model assignments."""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        return {"roles": await get_model_set(conn), "defaults": DEFAULT_MODEL_SET}


@app.post("/config/model-set")
async def update_model_set(payload: ModelSetUpdate):
    """Update role-based model assignments."""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        return {"roles": await set_model_set(conn, payload.model_dump(exclude_unset=True))}


@app.get("/config/models")
async def get_model_configuration():
    """Return available orchestrator models and the active selection."""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        current = await get_current_model_id(conn)
    return {"current_model": current, "models": AVAILABLE_MODELS}


@app.post("/config/models/select")
async def select_model(payload: ModelSelectionRequest):
    """Persist a new active model for the orchestrator."""
    model = resolve_model(payload.model_id)
    if not model:
        raise HTTPException(status_code=404, detail="Unknown model ID")

    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await set_orchestrator_setting(
            conn,
            "current_model",
            {"model_id": model["id"]},
        )
    return {"status": "updated", "model": model}


@app.get("/projects/tracking")
async def list_project_tracking():
    """Return tracking metadata for all projects."""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
                p.id AS project_id,
                p.name,
                COALESCE(pt.is_tracked, FALSE) AS is_tracked,
                pt.repo_path,
                pt.repo_paths,
                COALESCE(pt.embedding_status, 'not_tracked') AS embedding_status,
                pt.embedding_last_indexed,
                pt.preferred_model_id,
                pt.embedding_model_id,
                pt.text_embedding_model_id,
                pt.embedding_mode,
                COALESCE(pt.global_embedding_status, 'not_tracked') AS global_embedding_status,
                pt.global_embedding_last_indexed,
                pt.global_embedding_mode,
                pt.global_code_model_id,
                pt.global_text_model_id,
                pt.embedding_stats,
                pt.global_embedding_stats,
                COALESCE(pt.gpu_enabled, FALSE) AS gpu_enabled,
                pt.gpu_device,
                COALESCE(pt.embedding_enabled, TRUE) AS embedding_enabled,
                COALESCE(pt.auto_index_enabled, TRUE) AS auto_index_enabled,
                pt.resource_profile_id,
                pt.notes
            FROM projects p
            LEFT JOIN project_tracking pt ON pt.project_id = p.id
            WHERE p.id <> $1
            ORDER BY p.name
            """,
            GLOBAL_RAG_PROJECT_ID,
        )
    results = []
    for row in rows:
        data = dict(row)
        data["project_id"] = str(data["project_id"])
        repo_paths_raw = data.get("repo_paths")
        if repo_paths_raw:
            paths = [path.strip() for path in repo_paths_raw.splitlines() if path and path.strip()]
        else:
            paths = []
        data["repo_paths"] = paths
        if not data.get("repo_path") and paths:
            data["repo_path"] = paths[0]
        results.append(data)
    return results


@app.post("/projects")
async def create_project(payload: ProjectCreate):
    """Create a new project and optionally set its repo path and tracking metadata."""
    project_name = derive_project_name(payload.repo_path, payload.name)
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        # Insert into km's projects table
        project_id = await conn.fetchval(
            """
            INSERT INTO projects (name, description_md_path, status)
            VALUES ($1, $2, 'active')
            RETURNING id
            """,
            project_name,
            payload.description,
        )
        project_id = str(project_id)

        # Set up tracking row if any tracking info provided
        tracking_payload = ProjectTrackingUpdate(
            repo_path=payload.repo_path,
            is_tracked=payload.repo_path is not None,
            gpu_enabled=payload.gpu_enabled,
            gpu_device=payload.gpu_device,
            embedding_enabled=payload.embedding_enabled,
            auto_index_enabled=payload.auto_index_enabled,
            resource_profile_id=payload.resource_profile_id,
            notes=payload.notes,
            embedding_status=(
                "pending"
                if payload.repo_path and payload.embedding_enabled
                else "disabled"
                if payload.repo_path
                else "not_tracked"
            ),
        )
        tracking = await upsert_project_tracking(conn, project_id, tracking_payload)

    auto_index = None
    if payload.repo_path and payload.embedding_enabled and payload.auto_index_enabled:
        try:
            approval = _require_explicit_approval(
                payload.approved,
                payload.approved_by,
                action="project auto embedding",
            )
            auto_index = await _queue_embedding_job(
                project_id,
                EmbeddingJobRequest(approved=True, approved_by=approval["approved_by"]),
                approval,
            )
        except HTTPException as exc:
            auto_index = {
                "status": "not_queued",
                "reason": exc.detail,
            }

    async with pool.acquire() as conn:
        tracking = await fetch_project_tracking(conn, project_id)

    return {"project_id": project_id, "id": project_id, "name": project_name, **tracking, "auto_index": auto_index}


@app.get("/projects/{project_id}/tracking")
async def get_project_tracking(project_id: str):
    """Detailed tracking info for a project."""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await ensure_project_exists(conn, project_id)
        record = await fetch_project_tracking(conn, project_id)
    return record


@app.post("/projects/{project_id}/tracking")
async def update_project_tracking(project_id: str, payload: ProjectTrackingUpdate):
    """Create or update project tracking metadata."""
    if payload.embedding_status and payload.embedding_status not in TRACKING_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid embedding status '{payload.embedding_status}'",
        )
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        updated = await upsert_project_tracking(conn, project_id, payload)
    return updated


@app.post("/projects/{project_id}/tracking/index")
async def queue_embedding_job(project_id: str, payload: EmbeddingJobRequest):
    """Create a task to (re)index a project's repository."""
    approval = _require_explicit_approval(
        payload.approved,
        payload.approved_by,
        action="project embedding",
    )
    return await _queue_embedding_job(project_id, payload, approval)


@app.post("/memory/global/index")
async def queue_global_embedding(payload: GlobalEmbeddingRequest):
    """Create a task to index global embeddings for arbitrary paths."""
    approval = _require_explicit_approval(
        payload.approved,
        payload.approved_by,
        action="global embedding",
    )
    repo_paths = payload.repo_paths or []
    if payload.repo_path:
        repo_paths.append(payload.repo_path)
    repo_paths = [path.strip() for path in repo_paths if path and path.strip()]
    if not repo_paths:
        raise HTTPException(status_code=400, detail="At least one repo path is required")

    code_model_id = normalize_embedding_model_id(payload.code_model_id) or "microsoft/codebert-base"
    text_model_id = normalize_embedding_model_id(payload.text_model_id) or "BAAI/bge-base-en-v1.5"

    db_host, db_port = _worker_db_target("local")
    embeddings_script = Path(settings.host_repo_root) / "memory" / "run_embeddings.py"
    base_command = (
        f"python \"{embeddings_script}\""
        f" --mode {payload.mode}"
        " --target global"
        f" --code-model \"{code_model_id}\""
        f" --text-model \"{text_model_id}\""
        f" --db-host \"{db_host}\""
        f" --db-port {db_port}"
        f" --db-name \"{settings.postgres_db}\""
        f" --db-user \"{settings.postgres_user}\""
        f" --db-password \"{settings.postgres_password}\""
    )
    if payload.force_reindex:
        base_command += " --force-reindex"

    command = "set -e\n" + "\n".join(
        f"{base_command} --repo-path \"{path}\""
        for path in repo_paths
    )

    task_queue = TaskQueue(queue_path=settings.task_queue_path)
    description = (
        "Run global repository embeddings.\n"
        f"Repository paths:\n" + "\n".join(f"- {path}" for path in repo_paths)
    )
    context = {
        "job_type": "index_global_repo",
        "mode": payload.mode,
        "target": "global",
        "repo_paths": repo_paths,
        "code_model_id": code_model_id,
        "text_model_id": text_model_id,
        "force_reindex": payload.force_reindex,
        "command": command,
        "approval": approval,
    }

    first_repo = Path(repo_paths[0]).name if len(repo_paths) == 1 else f"{len(repo_paths)} paths"
    task_id = task_queue.create_task(
        project_id=GLOBAL_TASK_PROJECT_ID,
        task_title=f"Embed global repository - {first_repo}",
        description=description,
        priority=TaskPriority.HIGH,
        cli_preference="local",
        working_dir=settings.host_repo_root,
        context=context,
    )

    return {"status": "queued", "task_id": task_id}


@app.get("/stats")
async def get_stats():
    """Get orchestrator statistics"""
    pool = await get_db_pool()

    async with pool.acquire() as conn:
        task_counts = await conn.fetch("""
            SELECT status, COUNT(*) as count
            FROM tasks
            GROUP BY status
        """)

        project_count = await conn.fetchval("SELECT COUNT(*) FROM projects")

    stats = {
        "tasks": {row['status']: row['count'] for row in task_counts},
        "projects": project_count
    }

    return stats


@app.get("/memory/items")
async def list_memory_items(
    project_id: Optional[str] = None,
    category: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    """List memory items with optional filters."""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        clauses: List[str] = []
        params: List[object] = []

        if project_id:
            params.append(project_id)
            clauses.append(f"m.project_id = ${len(params)}")

        if category:
            params.append(category)
            clauses.append(
                f"""
                m.memory_id IN (
                    SELECT mc.memory_id
                    FROM memory_categories mc
                    JOIN categories c ON c.category_id = mc.category_id
                    WHERE c.name = ${len(params)}
                )
                """
            )

        if search:
            params.append(f"%{search}%")
            clauses.append(f"m.content ILIKE ${len(params)}")

        where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.extend([limit, offset])

        query = f"""
            SELECT
                m.memory_id,
                m.content,
                m.project_id,
                m.task_id,
                m.system_id,
                m.created_by,
                m.created_at,
                m.last_accessed_at,
                m.access_count,
                m.user_feedback,
                COALESCE(array_remove(array_agg(c.name ORDER BY c.name), NULL), '{{}}'::text[]) AS categories
            FROM memory_items m
            LEFT JOIN memory_categories mc ON mc.memory_id = m.memory_id
            LEFT JOIN categories c ON c.category_id = mc.category_id
            {where_sql}
            GROUP BY m.memory_id
            ORDER BY m.created_at DESC
            LIMIT ${len(params) - 1}
            OFFSET ${len(params)}
        """
        rows = await conn.fetch(query, *params)
        return [dict(row) for row in rows]


@app.get("/memory/global/items")
async def list_global_memory_items(
    category: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    """List global memory items with optional filters."""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        clauses: List[str] = []
        params: List[object] = []

        if category:
            params.append(category)
            clauses.append(
                f"""
                m.memory_id IN (
                    SELECT mc.memory_id
                    FROM global_memory_categories mc
                    JOIN categories c ON c.category_id = mc.category_id
                    WHERE c.name = ${len(params)}
                )
                """
            )

        if search:
            params.append(f"%{search}%")
            clauses.append(f"m.content ILIKE ${len(params)}")

        where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.extend([limit, offset])

        query = f"""
            SELECT
                m.memory_id,
                m.content,
                m.source_key,
                m.source_project_id,
                m.created_by,
                m.created_at,
                m.last_accessed_at,
                m.access_count,
                m.user_feedback,
                COALESCE(array_remove(array_agg(c.name ORDER BY c.name), NULL), '{{}}'::text[]) AS categories
            FROM global_memory_items m
            LEFT JOIN global_memory_categories mc ON mc.memory_id = m.memory_id
            LEFT JOIN categories c ON c.category_id = mc.category_id
            {where_sql}
            GROUP BY m.memory_id
            ORDER BY m.created_at DESC
            LIMIT ${len(params) - 1}
            OFFSET ${len(params)}
        """
        rows = await conn.fetch(query, *params)
        return [dict(row) for row in rows]


@app.get("/memory/embedding-runs")
async def list_embedding_runs(
    status: Optional[str] = None,
    limit: int = Query(default=5, ge=1, le=50),
):
    """Return recent embedding runs with stats."""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        if status:
            rows = await conn.fetch(
                """
                SELECT run_id, project_id, target, mode, status,
                       started_at, finished_at, stats, error
                FROM embedding_runs
                WHERE status = $1
                ORDER BY started_at DESC NULLS LAST
                LIMIT $2
                """,
                status,
                limit,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT run_id, project_id, target, mode, status,
                       started_at, finished_at, stats, error
                FROM embedding_runs
                ORDER BY started_at DESC NULLS LAST
                LIMIT $1
                """,
                limit,
            )
    return [dict(row) for row in rows]


@app.get("/memory/stats")
async def memory_stats():
    """Return aggregate statistics for the memory subsystem."""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        total = await conn.fetchval("SELECT COUNT(*) FROM memory_items")
        by_project = await conn.fetch(
            """
            SELECT project_id, COUNT(*) AS count
            FROM memory_items
            GROUP BY project_id
            ORDER BY count DESC NULLS LAST
            LIMIT 10
            """
        )
        by_category = await conn.fetch(
            """
            SELECT c.name AS category, COUNT(*) AS count
            FROM categories c
            JOIN memory_categories mc ON mc.category_id = c.category_id
            GROUP BY c.name
            ORDER BY count DESC
            """
        )
        latest = await conn.fetchrow(
            """
            SELECT memory_id, project_id, created_at, created_by
            FROM memory_items
            ORDER BY created_at DESC
            LIMIT 1
            """
        )

    return {
        "total": total or 0,
        "by_project": [dict(row) for row in by_project],
        "by_category": [dict(row) for row in by_category],
        "latest": dict(latest) if latest else None,
    }


@app.get("/memory/global/stats")
async def global_memory_stats():
    """Return aggregate statistics for global memory."""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        total = await conn.fetchval("SELECT COUNT(*) FROM global_memory_items")
        top_used = await conn.fetch(
            """
            SELECT memory_id, access_count, created_at
            FROM global_memory_items
            ORDER BY access_count DESC, created_at DESC
            LIMIT 5
            """
        )
        rate = await conn.fetchrow(
            """
            SELECT
                COALESCE(SUM(access_count), 0) AS total_accesses,
                COALESCE(AVG(EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400), 0) AS avg_age_days
            FROM global_memory_items
            """
        )

    avg_age = float(rate["avg_age_days"]) if rate else 0.0
    total_accesses = int(rate["total_accesses"]) if rate else 0
    overall_ratio = (total_accesses / avg_age) if avg_age > 0 else 0.0
    return {
        "total": total or 0,
        "top_used": [dict(row) for row in top_used],
        "overall_frequency_ratio": overall_ratio,
    }


@app.delete("/memory/items/{memory_id}")
async def delete_memory_item(memory_id: str):
    """Delete a memory entry."""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM memory_items WHERE memory_id = $1",
            memory_id,
        )
        if result.endswith("0"):
            raise HTTPException(status_code=404, detail="Memory item not found")
    return {"status": "deleted", "memory_id": memory_id}


@app.post("/memory/feedback")
async def update_memory_feedback(payload: MemoryFeedbackRequest):
    """Update user feedback score for a memory."""
    pool = await get_db_pool()
    feedback_value = None if payload.feedback == 0 else payload.feedback

    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE memory_items
            SET user_feedback = $2
            WHERE memory_id = $1
            """,
            payload.memory_id,
            feedback_value,
        )
        if result.endswith("0"):
            raise HTTPException(status_code=404, detail="Memory item not found")

    return {"status": "updated", "memory_id": payload.memory_id, "feedback": feedback_value}


@app.post("/memory/items")
async def add_memory_item(payload: MemoryAddRequest):
    """Create a memory entry with server-side embeddings."""
    if not payload.content.strip():
        raise HTTPException(status_code=400, detail="content is required")

    try:
        embedder = get_text_embedder()
        embedding = embedder.embed_query(payload.content)
    except Exception as exc:
        logger.error("Failed to embed memory content", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Embedding failed: {exc}") from exc

    pool = await get_db_pool()
    async with pool.acquire() as conn:
        memory_id = await memory_manager.add_memory(
            conn,
            content=payload.content,
            embedding=embedding,
            project_id=payload.project_id,
            task_id=payload.task_id,
            system_id=payload.system_id,
            created_by=payload.created_by or "koweb",
            categories=payload.categories,
        )
    return {"status": "created", "memory_id": memory_id}


@app.post("/memory/search-text")
async def search_memory_text(payload: MemorySearchTextRequest):
    """Perform semantic search with server-side text embeddings."""
    if not payload.query.strip():
        raise HTTPException(status_code=400, detail="query is required")

    embedder = get_text_embedder()
    query_embedding = embedder.embed_query(payload.query)

    pool = await get_db_pool()
    async with pool.acquire() as conn:
        matches = await memory_manager.search(
            conn,
            embedding=query_embedding,
            project_id=payload.project_id,
            system_id=payload.system_id,
            task_id=payload.task_id,
            categories=payload.categories,
            top_k=payload.top_k,
        )
        if not matches:
            return []

        memory_ids = [uuid.UUID(m_id) for (m_id, _score) in matches]
        detail_rows = await conn.fetch(
            """
            SELECT
                m.memory_id,
                m.content,
                m.project_id,
                m.task_id,
                m.system_id,
                m.created_by,
                m.created_at,
                m.last_accessed_at,
                m.access_count,
                m.user_feedback,
                COALESCE(array_remove(array_agg(c.name ORDER BY c.name), NULL), '{}'::text[]) AS categories
            FROM memory_items m
            LEFT JOIN memory_categories mc ON mc.memory_id = m.memory_id
            LEFT JOIN categories c ON c.category_id = mc.category_id
            WHERE m.memory_id = ANY($1::uuid[])
            GROUP BY m.memory_id
        """,
            memory_ids,
        )
        details = {}
        for row in detail_rows:
            record = dict(row)
            record["memory_id"] = str(record["memory_id"])
            details[record["memory_id"]] = record

    response = []
    for memory_id, similarity in matches:
        info = details.get(memory_id)
        if info:
            info["similarity"] = similarity
            response.append(info)
    return response


@app.post("/memory/global/search-text")
async def search_global_memory_text(payload: MemorySearchTextRequest):
    """Perform semantic search with server-side text embeddings (global)."""
    if not payload.query.strip():
        raise HTTPException(status_code=400, detail="query is required")

    embedder = get_text_embedder()
    query_embedding = embedder.embed_query(payload.query)

    pool = await get_db_pool()
    async with pool.acquire() as conn:
        matches = await memory_manager.search(
            conn,
            embedding=query_embedding,
            categories=payload.categories,
            top_k=payload.top_k,
            table="global_memory_items",
            category_table="global_memory_categories",
        )
        if not matches:
            return []

        memory_ids = [uuid.UUID(m_id) for (m_id, _score) in matches]
        detail_rows = await conn.fetch(
            """
            SELECT
                m.memory_id,
                m.content,
                m.source_key,
                m.source_project_id,
                m.created_by,
                m.created_at,
                m.last_accessed_at,
                m.access_count,
                m.user_feedback,
                COALESCE(array_remove(array_agg(c.name ORDER BY c.name), NULL), '{}'::text[]) AS categories
            FROM global_memory_items m
            LEFT JOIN global_memory_categories mc ON mc.memory_id = m.memory_id
            LEFT JOIN categories c ON c.category_id = mc.category_id
            WHERE m.memory_id = ANY($1::uuid[])
            GROUP BY m.memory_id
            """,
            memory_ids,
        )
        details = {}
        for row in detail_rows:
            record = dict(row)
            record["memory_id"] = str(record["memory_id"])
            details[record["memory_id"]] = record

    response = []
    for memory_id, similarity in matches:
        info = details.get(memory_id)
        if info:
            info["similarity"] = similarity
            response.append(info)
    return response


@app.post("/memory/search")
async def search_memory(payload: MemorySearchRequest):
    """Perform a semantic search against memory embeddings."""
    if not payload.embedding:
        raise HTTPException(status_code=400, detail="embedding vector required")

    pool = await get_db_pool()
    async with pool.acquire() as conn:
        matches = await memory_manager.search(
            conn,
            embedding=np.asarray(payload.embedding, dtype=np.float32),
            project_id=payload.project_id,
            system_id=payload.system_id,
            task_id=payload.task_id,
            categories=payload.categories,
            top_k=payload.top_k,
        )
        if not matches:
            return []

        memory_ids = [uuid.UUID(m_id) for (m_id, _score) in matches]
        detail_rows = await conn.fetch(
            """
            SELECT
                m.memory_id,
                m.content,
                m.project_id,
                m.task_id,
                m.system_id,
                m.created_by,
                m.created_at,
                m.last_accessed_at,
                m.access_count,
                m.user_feedback,
                COALESCE(array_remove(array_agg(c.name ORDER BY c.name), NULL), '{}'::text[]) AS categories
            FROM memory_items m
            LEFT JOIN memory_categories mc ON mc.memory_id = m.memory_id
            LEFT JOIN categories c ON c.category_id = mc.category_id
            WHERE m.memory_id = ANY($1::uuid[])
            GROUP BY m.memory_id
        """,
            memory_ids,
        )
        details = {}
        for row in detail_rows:
            record = dict(row)
            record["memory_id"] = str(record["memory_id"])
            details[record["memory_id"]] = record

    response = []
    for memory_id, similarity in matches:
        info = details.get(memory_id)
        if info:
            info["similarity"] = similarity
            response.append(info)
    return response


@app.post("/memory/code-search/{project_id}")
async def code_search_endpoint(project_id: str, payload: CodeSearchRequest):
    """Vector-only search across indexed code chunks."""
    await _promote_embeddings_if_project_requested(project_id)
    pool = await get_db_pool()
    embedder = get_code_embedder()
    query_embedding = embedder.embed_query(payload.query)
    async with pool.acquire() as conn:
        results = await search_code(conn, project_id, query_embedding, top_k=payload.top_k)
    for row in results:
        row["similarity"] = float(row["similarity"])
    return results


@app.post("/memory/code-index/{project_id}")
async def code_index_endpoint(project_id: str, payload: CodeIndexRequest):
    """Queue a host-side code indexing job for the given project."""
    approval = _require_explicit_approval(
        payload.approved,
        payload.approved_by,
        action="project code indexing",
    )
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await ensure_project_exists(conn, project_id)
        tracking = await fetch_project_tracking(conn, project_id)
        project = await conn.fetchrow(
            "SELECT name FROM projects WHERE id = $1",
            project_id,
        )

    repo_path = payload.repo_path or tracking.get("repo_path")
    if not repo_path:
        raise HTTPException(status_code=400, detail="repo_path is required for code indexing")

    model_id = payload.model_id or tracking.get("embedding_model_id") or "microsoft/codebert-base"
    db_host, db_port = _worker_db_target("local")
    code_index_script = Path(settings.host_repo_root) / "memory" / "code_indexer.py"
    command = (
        f"python \"{code_index_script}\" --repo-path \"{repo_path}\" "
        f"--project-id {project_id} --db-host \"{db_host}\" --db-port {db_port} "
        f"--db-name \"{settings.postgres_db}\" --db-user \"{settings.postgres_user}\" "
        f"--db-password \"{settings.postgres_password}\" --model \"{model_id}\""
    )
    description = (
        "Run code-aware repository indexing.\n"
        f"Project: {project['name']} ({project_id})\n"
        f"Repo path: {repo_path}\n"
        f"Model: {model_id}\n"
        "Command:\n"
        f"{command}"
    )
    context = {
        "job_type": "code_index",
        "repo_path": repo_path,
        "model_id": model_id,
        "force_reindex": payload.force_reindex,
        "command": command,
        "approval": approval,
    }

    task_queue = TaskQueue(queue_path=settings.task_queue_path)
    task_id = task_queue.create_task(
        project_id=project_id,
        task_title=f"Code index - {project['name']}",
        description=description,
        priority=TaskPriority.HIGH,
        cli_preference="local",
        working_dir=settings.host_repo_root,
        context=context,
    )
    return {"status": "queued", "task_id": task_id}


@app.post("/memory/text-search/{project_id}")
async def text_search_endpoint(project_id: str, req: TextSearchRequest) -> dict:
    """Search text chunks for a project using hybrid retrieval."""
    await _promote_embeddings_if_project_requested(project_id)
    embedder = get_text_embedder()
    query_embedding = embedder.embed_query(req.query)
    table = req.table if req.table in {"text_chunks", "global_text_chunks"} else "text_chunks"
    owner_column = "project_id" if table == "text_chunks" else "source_key"
    reranker = get_reranker() if req.use_reranker else None
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        results = await hybrid_search(
            conn, table, owner_column, project_id,
            req.query, query_embedding,
            top_k=req.top_k,
            use_reranker=req.use_reranker,
            reranker=reranker,
        )
        if results:
            source_ids = [row.get("source_id") for row in results if row.get("source_id")]
            source_map: dict[str, dict] = {}
            if source_ids:
                source_rows = await conn.fetch(
                    """
                    SELECT id, source_label, original_filename, mime_type, ingest_method
                    FROM project_text_sources
                    WHERE id = ANY($1::uuid[])
                    """,
                    source_ids,
                )
                source_map = {str(row["id"]): dict(row) for row in source_rows}
            for row in results:
                source_id = row.get("source_id")
                if source_id and str(source_id) in source_map:
                    meta = source_map[str(source_id)]
                    row["source_id"] = str(source_id)
                    row["source_label"] = meta["source_label"]
                    row["original_filename"] = meta["original_filename"]
                    row["mime_type"] = meta["mime_type"]
                    row["ingest_method"] = meta["ingest_method"]
    return {"results": results, "count": len(results)}


@app.post("/memory/text-index/{project_id}")
async def text_index_endpoint(project_id: str, req: TextIndexRequest) -> dict:
    """Queue a text indexing job for a project."""
    approval = _require_explicit_approval(
        req.approved,
        req.approved_by,
        action="project text indexing",
    )
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await ensure_project_exists(conn, project_id)
        project = await conn.fetchrow(
            "SELECT name FROM projects WHERE id = $1",
            project_id,
        )

    text_model_id = "BAAI/bge-base-en-v1.5"
    db_host, db_port = _worker_db_target("local")
    embeddings_script = Path(settings.host_repo_root) / "memory" / "run_embeddings.py"
    command = (
        f"python \"{embeddings_script}\""
        f" --repo-path \"{req.repo_path}\""
        f" --project-id {project_id}"
        f" --mode text"
        f" --target {req.target}"
        f" --text-model \"{text_model_id}\""
        f" --db-host \"{db_host}\""
        f" --db-port {db_port}"
        f" --db-name \"{settings.postgres_db}\""
        f" --db-user \"{settings.postgres_user}\""
        f" --db-password \"{settings.postgres_password}\""
    )
    if req.force_reindex:
        command += " --force-reindex"
    if req.include_pdfs:
        command += " --include-pdfs"
    else:
        command += " --no-include-pdfs"

    project_name = project['name'] if project else project_id
    description = (
        "Run text document indexing for project.\n"
        f"Project: {project_name} ({project_id})\n"
        f"Repo path: {req.repo_path}\n"
        f"Mode: text\n"
        f"Target: {req.target}\n"
        f"Include PDFs: {req.include_pdfs}\n"
        "Command:\n"
        f"{command}"
    )
    context = {
        "job_type": "text_index",
        "repo_path": req.repo_path,
        "text_model_id": text_model_id,
        "force_reindex": req.force_reindex,
        "include_pdfs": req.include_pdfs,
        "command": command,
        "approval": approval,
    }

    task_queue = TaskQueue(queue_path=settings.task_queue_path)
    task_id = task_queue.create_task(
        project_id=project_id,
        task_title=f"Text index - {project_name}",
        description=description,
        priority=TaskPriority.HIGH,
        cli_preference="local",
        working_dir=settings.host_repo_root,
        context=context,
    )
    return {"status": "queued", "task_id": task_id}


@app.post("/memory/ingest-text/{project_id}")
async def ingest_text_endpoint(project_id: str, req: IngestTextRequest) -> dict:
    """Ingest a small text document directly (synchronous)."""
    pool = await get_db_pool()
    result = await ingest_bytes_as_source(
        pool,
        project_id=project_id,
        filename=f"{req.source_label}.txt",
        data=req.content.encode("utf-8"),
        source_label=req.source_label,
        ingest_method="api",
    )
    return {"chunks_indexed": result.get("chunk_count", 0), "source_label": req.source_label, "source_id": result.get("source_id")}


@app.post("/memory/upload-files/{project_id}")
async def upload_files_endpoint(
    project_id: str,
    files: list[UploadFile] = File(...),
    replace_existing: bool = Form(False),
    dedupe_by_hash: bool = Form(False),
    reindex_if_same_name: bool = Form(False),
    conversation_format: str | None = Form(None),
) -> dict:
    """Upload one or more source files into a project."""
    del reindex_if_same_name
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await ensure_project_exists(conn, project_id)
    file_payloads: list[tuple[str, bytes, str | None]] = []
    for upload in files:
        file_payloads.append((upload.filename or "upload", await upload.read(), upload.content_type))
    results = await ingest_uploaded_files(
        pool,
        project_id=project_id,
        files=file_payloads,
        replace_existing=replace_existing,
        dedupe_by_hash=dedupe_by_hash,
        conversation_format=conversation_format,
    )
    return {"results": results, "count": len(results)}


@app.get("/memory/sources/{project_id}")
async def list_project_sources_endpoint(project_id: str) -> dict:
    """List source registry entries for a project."""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await ensure_project_exists(conn, project_id)
    rows = await list_project_sources(pool, project_id)
    return {"sources": rows, "count": len(rows)}


@app.delete("/memory/sources/{project_id}/{source_id}")
async def delete_project_source_endpoint(project_id: str, source_id: str) -> dict:
    """Delete a project source and all associated chunks."""
    pool = await get_db_pool()
    try:
        return await delete_project_source(pool, project_id, source_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/memory/sources/{project_id}/{source_id}/reingest")
async def reingest_project_source_endpoint(project_id: str, source_id: str) -> dict:
    """Reingest an existing project source from stored content."""
    pool = await get_db_pool()
    try:
        return await reingest_project_source(pool, project_id=project_id, source_id=source_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/memory/sources/{project_id}/{source_id}/replace")
async def replace_project_source_endpoint(
    project_id: str,
    source_id: str,
    file: UploadFile = File(...),
    conversation_format: str | None = Form(None),
) -> dict:
    """Replace the stored file for an existing source and reindex it."""
    pool = await get_db_pool()
    try:
        return await replace_project_source(
            pool,
            project_id=project_id,
            source_id=source_id,
            filename=file.filename or "replacement",
            data=await file.read(),
            conversation_format=conversation_format,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/memory/text-chunks/{project_id}")
async def list_text_chunks_endpoint(
    project_id: str,
    limit: int = 50,
    offset: int = 0,
    file_path: Optional[str] = None,
) -> dict:
    """List text chunks for a project with pagination."""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        if file_path is not None:
            rows = await conn.fetch(
                """
                SELECT
                    tc.id,
                    tc.file_path,
                    tc.chunk_index,
                    tc.chunk_type,
                    tc.header_context,
                    tc.content,
                    tc.source_type,
                    tc.source_id,
                    pts.source_label,
                    pts.original_filename,
                    pts.mime_type,
                    pts.ingest_method,
                    tc.created_at
                FROM text_chunks tc
                LEFT JOIN project_text_sources pts ON pts.id = tc.source_id
                WHERE tc.project_id = $1 AND tc.file_path = $2
                ORDER BY tc.file_path, tc.chunk_index
                LIMIT $3 OFFSET $4
                """,
                project_id,
                file_path,
                limit,
                offset,
            )
            total = await conn.fetchval(
                "SELECT COUNT(*) FROM text_chunks WHERE project_id = $1 AND file_path = $2",
                project_id,
                file_path,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT
                    tc.id,
                    tc.file_path,
                    tc.chunk_index,
                    tc.chunk_type,
                    tc.header_context,
                    tc.content,
                    tc.source_type,
                    tc.source_id,
                    pts.source_label,
                    pts.original_filename,
                    pts.mime_type,
                    pts.ingest_method,
                    tc.created_at
                FROM text_chunks tc
                LEFT JOIN project_text_sources pts ON pts.id = tc.source_id
                WHERE tc.project_id = $1
                ORDER BY tc.file_path, tc.chunk_index
                LIMIT $2 OFFSET $3
                """,
                project_id,
                limit,
                offset,
            )
            total = await conn.fetchval(
                "SELECT COUNT(*) FROM text_chunks WHERE project_id = $1",
                project_id,
            )
    return {"chunks": [dict(r) for r in rows], "total": total, "limit": limit, "offset": offset}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        log_level=settings.log_level.lower(),
        reload=False
    )
