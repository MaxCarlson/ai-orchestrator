"""
AI Orchestrator - Task Dispatcher and Coordinator
Manages task assignment to external CLIs and local LLMs on RTX 5090
"""
import asyncio
import json
import logging
import uuid
from contextlib import asynccontextmanager
from typing import AsyncGenerator, List, Optional

import asyncpg
import numpy as np
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings

from memory.manager import MemoryManager, initialize_schema


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
]


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
        # Ensure a default model record exists
        current_model = await get_orchestrator_setting(conn, "current_model")
        if not current_model:
            await set_orchestrator_setting(
                conn,
                "current_model",
                {"model_id": AVAILABLE_MODELS[0]["id"]},
            )


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
from shared.task_queue import TaskQueue, TaskStatus
import subprocess


# Task processing
async def process_pending_tasks():
    """Poll task queue filesystem and dispatch to CLI workers"""
    task_queue = TaskQueue(queue_path=settings.task_queue_path)
    logger.info("Task processor started - polling task queue...")

    while True:
        try:
            # Get queued tasks
            queued_tasks = task_queue.list_tasks(TaskStatus.QUEUED, limit=10)

            if queued_tasks:
                logger.info(f"Found {len(queued_tasks)} queued tasks")

                for task_data in queued_tasks:
                    task_id = task_data['task_id']
                    cli_preference = task_data.get('cli_preference', 'claude')

                    logger.info(f"Assigning task {task_id[:8]} to {cli_preference}")

                    # Assign task
                    success = task_queue.assign_task(
                        task_id,
                        assigned_to=f"{cli_preference}-worker",
                        worker_pid=None  # Will be set by worker
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


class ManualTaskCreate(BaseModel):
    project_id: str
    title: str
    description: str
    cli_preference: str = "claude"
    priority: int = Field(default=3, ge=1, le=5)
    working_dir: Optional[str] = None


class ModelSelectionRequest(BaseModel):
    model_id: str


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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        log_level=settings.log_level.lower(),
        reload=False
    )
