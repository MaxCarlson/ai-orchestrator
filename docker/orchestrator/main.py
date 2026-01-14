"""
AI Orchestrator - Task Dispatcher and Coordinator
Manages task assignment to external CLIs and local LLMs on RTX 5090
"""
import asyncio
import json
import logging
import uuid
from contextlib import asynccontextmanager
from typing import AsyncGenerator, List, Optional, Literal

import asyncpg
import numpy as np
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings

from memory.code_embeddings import CodeEmbedder
from memory.code_search import search_code
from memory.manager import MemoryManager, initialize_schema
from memory.text_embeddings import TextEmbedder


# Configuration
class Settings(BaseSettings):
    # Database
    postgres_host: str = "postgres"
    postgres_port: int = 5432
    postgres_user: str = "km_user"
    postgres_password: str
    postgres_db: str = "knowledge_manager"

    # Orchestrator
    log_level: str = "INFO"
    worker_threads: int = 4
    task_poll_interval: int = 5  # seconds
    task_queue_path: str = "/app/task_queue"

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


AVAILABLE_MODELS = [
    {
        "id": "claude-3-5-sonnet",
        "label": "Claude 3.5 Sonnet (Anthropic)",
        "provider": "anthropic",
        "capabilities": ["code", "analysis"],
    },
    {
        "id": "claude-3-opus",
        "label": "Claude 3 Opus (Anthropic)",
        "provider": "anthropic",
        "capabilities": ["analysis"],
    },
    {
        "id": "gpt-4.1-mini",
        "label": "GPT-4.1 Mini (OpenAI)",
        "provider": "openai",
        "capabilities": ["general"],
    },
    {
        "id": "qwen2.5-coder-32b",
        "label": "Qwen2.5 Coder 32B (RTX 5090)",
        "provider": "local-llm",
        "endpoint": "llama.cpp",
        "capabilities": ["code"],
    },
    {
        "id": "lmstudio-local",
        "label": "LM Studio (Local Server)",
        "provider": "local-llm",
        "endpoint": "lmstudio",
        "capabilities": ["chat", "code"],
    },
]

TRACKING_STATUSES = {
    "not_tracked",
    "pending",
    "indexing",
    "ready",
    "stale",
    "error",
}

CODE_CONTEXT_MAX_CHARS = 8000
CODE_CONTEXT_SNIPPET_CHARS = 1200


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
            gpu_enabled BOOLEAN NOT NULL DEFAULT FALSE,
            gpu_device TEXT,
            notes TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        """
    )
    await conn.execute(
        "ALTER TABLE project_tracking ADD COLUMN IF NOT EXISTS repo_paths TEXT;"
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


async def bootstrap_memory_and_settings() -> None:
    """Initialise memory schema and orchestrator settings."""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await initialize_schema(conn)
        await ensure_settings_schema(conn)
        await ensure_project_tracking_schema(conn)
        # Ensure a default model record exists
        current_model = await get_orchestrator_setting(conn, "current_model")
        if not current_model:
            await set_orchestrator_setting(
                conn,
                "current_model",
                {"model_id": AVAILABLE_MODELS[0]["id"]},
            )


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
        "gpu_enabled": False,
        "gpu_device": None,
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
            gpu_enabled,
            gpu_device,
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
    embedding_model_id = validate_model_choice(
        data.embedding_model_id or current["embedding_model_id"]
    )

    gpu_enabled = (
        data.gpu_enabled if data.gpu_enabled is not None else current["gpu_enabled"]
    )
    gpu_device = data.gpu_device if data.gpu_device is not None else current["gpu_device"]
    notes = data.notes if data.notes is not None else current["notes"]

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
            gpu_enabled,
            gpu_device,
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
            gpu_enabled = EXCLUDED.gpu_enabled,
            gpu_device = EXCLUDED.gpu_device,
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
        gpu_enabled,
        gpu_device,
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
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))
from shared.task_queue import TaskPriority, TaskQueue, TaskStatus
import subprocess


# Task processing
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
            # Get queued tasks
            queued_tasks = task_queue.list_tasks(TaskStatus.QUEUED, limit=10)
            project_locks = get_project_cli_locks()

            if queued_tasks:
                logger.info(f"Found {len(queued_tasks)} queued tasks")

                for task_data in queued_tasks:
                    task_id = task_data['task_id']
                    cli_preference = task_data.get('cli_preference', 'claude')
                    project_id = task_data.get('project_id')

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

    # Create worker script path
    worker_script = Path(__file__).parent.parent.parent / "cli_integrations" / f"{cli_type}_worker.sh"

    if not worker_script.exists():
        logger.warning(f"Worker script not found: {worker_script}")
        logger.info(f"Creating placeholder worker for {cli_type}")
        # For now, just mark as started and simulate work
        task_queue.start_task(task_id)
        # TODO: Implement actual CLI workers
        logger.info(f"Task {task_id[:8]} started (simulated)")
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


class ManualTaskCreate(BaseModel):
    project_id: str
    title: str
    description: str
    cli_preference: str = "claude"
    priority: int = Field(default=3, ge=1, le=5)
    working_dir: Optional[str] = None


class ModelSelectionRequest(BaseModel):
    model_id: str


class ProjectTrackingUpdate(BaseModel):
    repo_path: Optional[str] = None
    repo_paths: Optional[List[str]] = None
    is_tracked: Optional[bool] = None
    embedding_status: Optional[str] = None
    preferred_model_id: Optional[str] = None
    embedding_model_id: Optional[str] = None
    gpu_enabled: Optional[bool] = None
    gpu_device: Optional[str] = None
    notes: Optional[str] = None


class EmbeddingJobRequest(BaseModel):
    scope: Literal["code", "text", "both"] = "both"
    model_id: Optional[str] = None
    force_reindex: bool = False


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
    task_queue = TaskQueue()
    try:
        task_id = task_queue.create_task(
            project_id=payload.project_id,
            task_title=payload.title,
            description=payload.description,
            priority=payload.priority,
            cli_preference=payload.cli_preference,
            working_dir=payload.working_dir,
        )
    except Exception as exc:
        logger.error("Failed to queue manual task", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Unable to queue task: {exc}") from exc

    return {"task_id": task_id}


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
                COALESCE(pt.gpu_enabled, FALSE) AS gpu_enabled,
                pt.gpu_device,
                pt.notes
            FROM projects p
            LEFT JOIN project_tracking pt ON pt.project_id = p.id
            ORDER BY p.name
            """
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
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        await ensure_project_exists(conn, project_id)
        tracking = await fetch_project_tracking(conn, project_id)
        project = await conn.fetchrow(
            "SELECT name FROM projects WHERE id = $1",
            project_id,
        )

        repo_paths = tracking.get("repo_paths") or []
        if tracking.get("repo_path") and not repo_paths:
            repo_paths = [tracking["repo_path"]]

        if not tracking["is_tracked"] or not repo_paths:
            raise HTTPException(
                status_code=400,
                detail="Project must be tracked with a repository path before indexing",
            )

        model_id = (
            validate_model_choice(payload.model_id)
            or tracking["embedding_model_id"]
            or tracking["preferred_model_id"]
        )
        if model_id is None:
            model_id = AVAILABLE_MODELS[0]["id"]

        status_payload = ProjectTrackingUpdate(
            embedding_status="indexing",
            embedding_model_id=model_id,
        )
        await upsert_project_tracking(conn, project_id, status_payload)

        project_name = project["name"]
        repo_path = repo_paths[0]

    task_queue = TaskQueue(queue_path=settings.task_queue_path)
    commands = "\n".join(
        f"python memory/embed_repo.py --repo-path \"{path}\" --project-id {project_id}"
        for path in repo_paths
    )
    repo_paths_display = "\n".join(f"- {path}" for path in repo_paths)
    description = (
        "Run repository embedding for the selected project.\n"
        f"Project: {project_name} ({project_id})\n"
        f"Repository paths:\n{repo_paths_display}\n"
        f"Scope: {payload.scope}\n"
        "Command hint:\n"
        f"{commands}"
    )
    context = {
        "job_type": "index_repo",
        "scope": payload.scope,
        "repo_path": repo_path,
        "repo_paths": repo_paths,
        "model_id": model_id,
        "force_reindex": payload.force_reindex,
    }

    task_id = task_queue.create_task(
        project_id=project_id,
        task_title=f"Embed repository - {project_name}",
        description=description,
        priority=TaskPriority.HIGH,
        cli_preference="claude",
        context=context,
    )

    return {
        "status": "queued",
        "task_id": task_id,
        "embedding_status": "indexing",
    }


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

    embedder = get_text_embedder()
    embedding = embedder.embed_query(payload.content)

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
    command = (
        f"python memory/code_indexer.py --repo-path \"{repo_path}\" "
        f"--project-id {project_id} --db-host localhost --db-port 5432 "
        f"--db-name knowledge_manager --db-user km_user "
        f"--db-password \"$KM_POSTGRES_PASSWORD\" --model \"{model_id}\""
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
    }

    task_queue = TaskQueue(queue_path=settings.task_queue_path)
    task_id = task_queue.create_task(
        project_id=project_id,
        task_title=f"Code index - {project['name']}",
        description=description,
        priority=TaskPriority.HIGH,
        cli_preference="local",
        working_dir=repo_path,
        context=context,
    )
    return {"status": "queued", "task_id": task_id}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        log_level=settings.log_level.lower(),
        reload=False
    )
