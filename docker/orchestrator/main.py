"""
AI Orchestrator - Task Dispatcher and Coordinator
Manages task assignment to external CLIs and local LLMs on RTX 5090
"""
import asyncio
import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator

import asyncpg
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from pydantic_settings import BaseSettings


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
    task_queue = TaskQueue()
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        log_level=settings.log_level.lower(),
        reload=False
    )
