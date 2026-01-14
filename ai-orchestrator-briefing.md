# AI Orchestrator - Comprehensive Project Briefing

**Version:** 1.0  
**Last Updated:** January 2026  
**Purpose:** This document provides a complete technical overview of the AI Orchestrator project, enabling any LLM agent or developer to understand, contribute to, or extend the system without requiring access to the full repository.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Mission and Goals](#2-mission-and-goals)
3. [System Architecture](#3-system-architecture)
4. [Core Components](#4-core-components)
5. [Database Schema](#5-database-schema)
6. [Task Queue System](#6-task-queue-system)
7. [Memory Subsystem](#7-memory-subsystem)
8. [API Reference](#8-api-reference)
9. [CLI Workers](#9-cli-workers)
10. [Configuration and Deployment](#10-configuration-and-deployment)
11. [Key Workflows](#11-key-workflows)
12. [Current Implementation Status](#12-current-implementation-status)
13. [Development Roadmap](#13-development-roadmap)
14. [Troubleshooting Guide](#14-troubleshooting-guide)
15. [Glossary](#15-glossary)

---

## 1. Executive Summary

The AI Orchestrator is a distributed task management and coordination system designed to bridge human users, multiple LLM-based CLI tools (Claude Code, OpenAI Codex, Google Gemini), and local GPU-accelerated models running on an RTX 5090. The system maintains persistent project memory through PostgreSQL with pgvector embeddings, enabling context-aware task execution across sessions and devices.

The orchestrator operates as the central nervous system for AI-assisted development workflows, automatically routing tasks to appropriate workers based on complexity, availability, and user preferences while maintaining a comprehensive audit trail and enabling human oversight at every stage.

**Key Capabilities:**
- Real-time task dispatch to Claude Code, Codex, and Gemini CLIs
- Local LLM routing via llama.cpp for lightweight tasks
- Hierarchical memory system with semantic search (pgvector)
- Multi-device access through networked PostgreSQL
- Filesystem-based task queue with atomic state transitions
- Web and TUI monitoring interfaces
- Automatic artifact capture and result tracking

---

## 2. Mission and Goals

### 2.1 Mission Statement

Build a self-managing orchestration platform that coordinates human users, multiple LLM/CLI workers, and long-lived project memory so tasks move from idea to execution to verification with minimal human intervention. The orchestrator must:

1. React to new tasks in real time (LISTEN/NOTIFY, filesystem queue) and select the optimal worker (Claude/Codex/Gemini/local LLMs)
2. Maintain durable working memory (PostgreSQL + pgvector) per system/project/task so future work is contextually informed
3. Provide transparent monitoring and control surfaces (TUI/WebUI/APIs) so humans can inspect, override, or assign work efficiently

### 2.2 End-State Vision

- **Single pane of glass:** Web UI and CLI dashboards showing project status, worker activity, embedding health, model assignments, and memory statistics in one unified interface
- **Hybrid automation:** The orchestrator autonomously routes routine work to local GPUs or remote CLIs while surfacing approvals and edge cases to humans
- **Evergreen memory:** Each project maintains tracked repositories with regularly refreshed embeddings, feedback loops, and retention policies
- **Device-aware scale:** Multiple hosts (Termux, WSL, Windows) can contribute workers and indexing jobs while sharing the same PostgreSQL source of truth
- **Extensible skills:** New modules (LLM router, embedding pipelines, device trackers) plug in without rewriting core task/queue logic

### 2.3 Guiding Principles

1. **PostgreSQL is truth:** Tasks, projects, memory metadata, and tracking information live in the database so every UI and worker sees the same reality
2. **Human-in-the-loop by default:** Any automation leaves observability hooks and manual overrides; no silent long-running jobs
3. **Composable modules:** Memory, task queue, LLM router, and UIs remain loosely coupled via well-defined APIs
4. **Document once:** Every new feature or endpoint gets captured in documentation so future agents bootstrap quickly
5. **Test where feasible:** Even smoke tests beat ad-hoc verification; favor deterministic scripts

---

## 3. System Architecture

### 3.1 High-Level Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              HOST SYSTEM (WSL2 Ubuntu)                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│   USER INTERFACES                    CLI WORKERS              GPU SERVICES   │
│   ┌──────────────┐                  ┌──────────────┐        ┌─────────────┐ │
│   │    kmtui     │                  │ claude CLI   │        │  RTX 5090   │ │
│   │  (Terminal   │                  │ codex CLI    │        │ llama.cpp   │ │
│   │    TUI)      │                  │ gemini CLI   │        │ Qwen models │ │
│   └──────┬───────┘                  └──────┬───────┘        └──────┬──────┘ │
│          │                                 │                        │        │
│          │         ┌───────────────────────┼────────────────────────┘        │
│          │         │                       │                                  │
│   ┌──────▼─────────▼───────────────────────▼────────────────────────────┐   │
│   │              SHARED TASK QUEUE (Filesystem - Bind Mount)             │   │
│   │   task_queue/                                                        │   │
│   │   ├── queued/        ← kmtui writes tasks here                       │   │
│   │   ├── assigned/      ← Orchestrator assigns to workers               │   │
│   │   ├── in_progress/   ← Workers actively executing                    │   │
│   │   ├── completed/     ← Successful completions                        │   │
│   │   ├── failed/        ← Error states                                  │   │
│   │   └── results/       ← Worker output, logs, artifacts                │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                    DOCKER NETWORK (km-network)                       │   │
│   │                                                                       │   │
│   │   ┌─────────────────────────┐      ┌────────────────────────────┐   │   │
│   │   │   AI ORCHESTRATOR       │      │     POSTGRESQL 16          │   │   │
│   │   │   (FastAPI Container)   │◄────►│     + pgvector             │   │   │
│   │   │                         │      │                            │   │   │
│   │   │   - Task Dispatcher     │      │   Tables:                  │   │   │
│   │   │   - Worker Pool Manager │      │   - projects               │   │   │
│   │   │   - Memory Manager      │      │   - tasks                  │   │   │
│   │   │   - REST API (:8000)    │      │   - task_links             │   │   │
│   │   │   - LISTEN/NOTIFY       │      │   - memory_items           │   │   │
│   │   │                         │      │   - project_tracking       │   │   │
│   │   └─────────────────────────┘      │   - orchestrator_settings  │   │   │
│   │                                     │                            │   │   │
│   │                                     │   Port: 5432               │   │   │
│   │                                     └────────────────────────────┘   │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Component Communication

| From | To | Method | Purpose |
|------|-----|--------|---------|
| kmtui | PostgreSQL | Direct connection (asyncpg) | CRUD operations on projects/tasks |
| kmtui | Task Queue | Filesystem write | Submit tasks for AI execution |
| Orchestrator | PostgreSQL | Connection pool (asyncpg) | State management, LISTEN/NOTIFY |
| Orchestrator | Task Queue | Filesystem poll (5s) | Discover queued tasks |
| Orchestrator | CLI Workers | Subprocess spawn | Execute tasks |
| CLI Workers | Task Queue | Filesystem read/write | State transitions, results |
| Orchestrator | llama.cpp | HTTP (host.docker.internal:8080) | Local LLM inference |
| Web UI | Orchestrator | REST API + WebSocket | Monitoring, control |

### 3.3 Data Flow Summary

1. **Task Creation:** User creates task in kmtui → PostgreSQL stores metadata → User presses Ctrl+A → Task JSON written to `task_queue/queued/`
2. **Task Dispatch:** Orchestrator polls queue → Finds task → Moves to `assigned/` → Spawns CLI worker process on host
3. **Task Execution:** Worker moves task to `in_progress/` → Executes CLI command → Captures stdout/stderr → Detects modified files
4. **Task Completion:** Worker moves task to `completed/` or `failed/` → Results stored in `results/<task-id>/` → PostgreSQL updated
5. **Memory Integration:** Completed work may generate memories → Embeddings created → Stored in `memory_items` table → Available for future semantic search

---

## 4. Core Components

### 4.1 Orchestrator Service (Docker Container)

**Location:** `docker/orchestrator/main.py`  
**Technology:** Python 3.11, FastAPI, asyncpg  
**Container Name:** `km-orchestrator`  
**Port:** 8000

The orchestrator is the central coordination service responsible for:

- Maintaining a connection pool to PostgreSQL
- Subscribing to LISTEN/NOTIFY channels for real-time updates
- Polling the filesystem task queue every 5 seconds
- Assigning tasks to available CLI workers based on preferences
- Spawning worker processes on the host system
- Exposing REST API endpoints for monitoring and control
- Managing the memory subsystem schema and operations

**Key Functions:**
- `process_pending_tasks()`: Main polling loop that discovers and assigns tasks
- `spawn_cli_worker()`: Launches worker scripts via subprocess
- `bootstrap_memory_and_settings()`: Initializes database schema on startup

### 4.2 PostgreSQL Database (Docker Container)

**Image:** `pgvector/pgvector:pg16`  
**Container Name:** `km-postgres`  
**Port:** 5432  
**Volume:** `docker_postgres_data` (external, persistent)

PostgreSQL serves as the single source of truth for all persistent state:

- Project and task metadata (from knowledge_manager TUI)
- Cross-project task linking relationships
- Memory items with vector embeddings
- Project tracking configuration (repo paths, embedding status)
- Orchestrator settings (model selection, preferences)

**Extensions Enabled:**
- `uuid-ossp`: UUID generation
- `pgvector`: Vector similarity search
- `pgcrypto`: Cryptographic functions

### 4.3 Task Queue (Filesystem)

**Location:** `task_queue/` (bind-mounted to container at `/app/task_queue`)  
**Implementation:** `shared/task_queue.py`

The task queue uses the filesystem for simplicity and host-container interoperability:

- **Atomic operations:** Uses temp file + rename pattern for safety
- **Status directories:** Physical directories represent task states
- **JSON format:** Human-readable task definitions with all metadata
- **Results storage:** Worker output preserved with directory structure

### 4.4 CLI Workers (Host Processes)

**Location:** `cli_integrations/claude_worker.sh`

Workers execute on the host system (not in Docker) because they need:

- Access to host filesystem for code modifications
- SSH keys and credentials
- Git operations
- Direct terminal interaction with CLI tools

Each worker script handles:
- Moving task through state directories
- Executing the CLI command with timeout protection
- Capturing stdout/stderr to log files
- Detecting modified files (before/after snapshots)
- Copying artifacts to results directory
- Updating task JSON with completion metadata

### 4.5 Memory Subsystem

**Location:** `memory/` directory  
**Components:** `manager.py`, `vector_store.py`, `models.py`, `embed_repo.py`

The memory system provides long-lived, searchable context:

- **Hierarchical organization:** Global → System → Project → Task → Categories
- **Vector embeddings:** pgvector for semantic similarity search
- **Retention tracking:** Access counts, timestamps, user feedback
- **GPU-accelerated indexing:** `embed_repo.py` processes repositories on RTX 5090

### 4.6 Monitoring Interfaces

**TUI Viewer:** `orchestrator_viewer/` (Textual-based)  
**Command:** `kmorch`

The monitoring dashboard provides:
- System statistics panel (queue counts, worker status, token usage)
- Worker grid showing active tasks with live output preview
- Activity log with recent events
- Navigation to worker detail views

**Web UI:** Planned (see `docs/WEB_UI_DESIGN.md`)

---

## 5. Database Schema

### 5.1 Core Tables (Knowledge Manager)

```sql
-- Projects table
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    status project_status NOT NULL DEFAULT 'active',  -- ENUM: active, backlog, completed
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    description_md_path TEXT,
    device_scope TEXT DEFAULT 'global',  -- global, local, os_specific, custom
    created_device_id UUID REFERENCES devices(device_id)
);

-- Tasks table
CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title TEXT NOT NULL,
    status task_status NOT NULL DEFAULT 'todo',  -- ENUM: todo, in-progress, done
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    parent_task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    priority INTEGER CHECK (priority BETWEEN 1 AND 5),
    due_date DATE,
    details_md_path TEXT,
    device_scope TEXT DEFAULT 'inherit'
);

-- Cross-project task linking
CREATE TABLE task_links (
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    is_origin BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (task_id, project_id)
);
```

### 5.2 Orchestrator Tables

```sql
-- Project tracking for memory/embedding management
CREATE TABLE project_tracking (
    project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    is_tracked BOOLEAN NOT NULL DEFAULT FALSE,
    repo_path TEXT,                              -- Primary repository path
    repo_paths TEXT,                             -- Newline-separated list of paths
    embedding_status TEXT NOT NULL DEFAULT 'not_tracked',
        -- Values: not_tracked, pending, indexing, ready, stale, error
    embedding_last_indexed TIMESTAMPTZ,
    preferred_model_id TEXT,                     -- For task execution
    embedding_model_id TEXT,                     -- For generating embeddings
    gpu_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    gpu_device TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Orchestrator settings (key-value store)
CREATE TABLE orchestrator_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 5.3 Memory Tables

```sql
-- Systems (organizational hierarchy)
CREATE TABLE systems (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Memory items with vector embeddings
CREATE TABLE memory_items (
    memory_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content TEXT NOT NULL,
    embedding vector(768) NOT NULL,              -- pgvector type
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
    system_id UUID REFERENCES systems(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    access_count INTEGER NOT NULL DEFAULT 0,
    user_feedback SMALLINT,                      -- -5 to +5 rating
    active BOOLEAN NOT NULL DEFAULT TRUE
);

-- Categories for memory organization
CREATE TABLE categories (
    category_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    parent_id UUID REFERENCES categories(category_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Many-to-many: memories to categories
CREATE TABLE memory_categories (
    memory_id UUID NOT NULL REFERENCES memory_items(memory_id) ON DELETE CASCADE,
    category_id UUID NOT NULL REFERENCES categories(category_id) ON DELETE CASCADE,
    PRIMARY KEY (memory_id, category_id)
);

-- Vector similarity index
CREATE INDEX idx_memory_items_embedding 
ON memory_items USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

### 5.4 Device Tracking Tables (Multi-Device Support)

```sql
-- Device registry
CREATE TABLE devices (
    device_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_name TEXT NOT NULL UNIQUE,            -- "WSL-xeres", "Termux-Pixel"
    os_type TEXT NOT NULL,                       -- linux, windows, android, darwin
    hostname TEXT,
    ip_address INET,
    first_seen TIMESTAMPTZ DEFAULT NOW(),
    last_seen TIMESTAMPTZ DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE,
    capabilities JSONB DEFAULT '{}'::jsonb,      -- can_execute_tasks, has_gpu, etc.
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Project-device access control
CREATE TABLE project_devices (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    scope TEXT NOT NULL DEFAULT 'available',     -- primary, available, excluded
    sync_enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (project_id, device_id)
);
```

### 5.5 LISTEN/NOTIFY Triggers

The database fires notifications on task/project changes:

```sql
CREATE OR REPLACE FUNCTION notify_task_changes() RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify('task_updates', json_build_object(
        'operation', TG_OP,
        'table', TG_TABLE_NAME,
        'id', COALESCE(NEW.id, OLD.id),
        'data', CASE WHEN TG_OP = 'DELETE' THEN row_to_json(OLD) ELSE row_to_json(NEW) END,
        'timestamp', NOW()
    )::text);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Applied to: tasks, projects, task_links
```

---

## 6. Task Queue System

### 6.1 Directory Structure

```
task_queue/
├── queued/              # New tasks awaiting assignment
│   └── <task-uuid>.json
├── assigned/            # Tasks assigned to workers (not yet started)
│   └── <task-uuid>.json
├── in_progress/         # Tasks actively being executed
│   └── <task-uuid>.json
├── completed/           # Successfully finished tasks
│   └── <task-uuid>.json
├── failed/              # Tasks that encountered errors
│   └── <task-uuid>.json
└── results/             # Worker output and artifacts
    └── <task-uuid>/
        ├── stdout.log       # CLI standard output
        ├── stderr.log       # CLI standard error
        ├── output.txt       # Summary file
        ├── files_before.txt # Pre-execution file snapshot
        ├── files_after.txt  # Post-execution file snapshot
        ├── files_modified.txt # Diff of modified files
        └── artifacts/       # Copies of modified files
            └── <preserved-directory-structure>/
```

### 6.2 Task JSON Schema

```json
{
  "task_id": "550e8400-e29b-41d4-a716-446655440000",
  "project_id": "uuid-of-project",
  "task_title": "Implement user authentication",
  "description": "Add JWT-based authentication to the API",
  "priority": 3,
  "cli_preference": "claude",
  "working_dir": "/home/user/projects/myapp",
  "created_at": "2025-12-31T05:30:00Z",
  "created_by": "kmtui",
  "status": "queued",
  "context": {
    "project_name": "ai-orchestrator",
    "related_files": ["/path/to/file1.py"],
    "dependencies": [],
    "tags": ["backend", "security"]
  },
  "constraints": {
    "max_duration_seconds": 3600,
    "require_human_approval": false,
    "timeout_action": "fail"
  }
}
```

**Additional fields added during execution:**

```json
{
  "assigned_at": "2025-12-31T05:31:00Z",
  "assigned_to": "claude-worker",
  "worker_pid": 12345,
  "started_at": "2025-12-31T05:31:05Z",
  "heartbeat_at": "2025-12-31T05:35:00Z",
  "completed_at": "2025-12-31T05:45:00Z",
  "duration_seconds": 840,
  "exit_code": 0,
  "result": {
    "success": true,
    "summary": "Task completed successfully",
    "files_modified": 3,
    "working_dir": "/home/user/projects/myapp"
  },
  "output_path": "results/550e8400-e29b-41d4-a716-446655440000/"
}
```

### 6.3 State Transitions

```
                    ┌─────────┐
                    │ kmtui   │
                    │ submits │
                    └────┬────┘
                         │
                         ▼
                  ┌──────────────┐
                  │   QUEUED     │
                  └──────┬───────┘
                         │ orchestrator assigns
                         ▼
                  ┌──────────────┐
                  │  ASSIGNED    │
                  └──────┬───────┘
                         │ worker starts
                         ▼
                  ┌──────────────┐
                  │ IN_PROGRESS  │
                  └──────┬───────┘
                         │
           ┌─────────────┴─────────────┐
           │                           │
           ▼                           ▼
    ┌──────────────┐           ┌──────────────┐
    │  COMPLETED   │           │   FAILED     │
    └──────────────┘           └──────┬───────┘
                                      │ retry eligible?
                                      ▼
                               ┌──────────────┐
                               │   QUEUED     │
                               └──────────────┘
```

### 6.4 TaskQueue Python API

```python
from shared.task_queue import TaskQueue, TaskStatus, TaskPriority

queue = TaskQueue(queue_path="/path/to/task_queue")

# Create a task
task_id = queue.create_task(
    project_id="uuid",
    task_title="Implement feature",
    description="Detailed instructions...",
    priority=TaskPriority.HIGH,
    cli_preference="claude",
    working_dir="/home/user/project"
)

# Assign to worker
queue.assign_task(task_id, assigned_to="claude-worker", worker_pid=12345)

# Start execution
queue.start_task(task_id)

# Update heartbeat
queue.update_heartbeat(task_id)

# Complete task
queue.complete_task(task_id, result={"success": True, "summary": "Done"})

# Or fail task
queue.fail_task(task_id, error={"type": "TimeoutError", "message": "..."})

# Query queue
stats = queue.get_queue_stats()  # {"queued": 3, "in_progress": 2, ...}
tasks = queue.list_tasks(TaskStatus.QUEUED, limit=10)
```

---

## 7. Memory Subsystem

### 7.1 Hierarchical Organization

```
Global (System)
├── System-level memories (shared across all projects)
├── Projects
│   ├── Project A
│   │   ├── Project-scoped memories
│   │   └── Tasks
│   │       ├── Task-scoped memories
│   │       └── Subtasks
│   └── Project B
│       └── ...
└── Categories (cross-cutting)
    ├── code
    ├── documentation
    ├── design-decisions
    ├── debugging
    └── ...
```

### 7.2 Memory Manager API

```python
from memory.manager import MemoryManager, initialize_schema
import numpy as np

# Initialize schema (run once on startup)
async with pool.acquire() as conn:
    await initialize_schema(conn)

# Create memory manager
mgr = MemoryManager()

# Add a memory
memory_id = await mgr.add_memory(
    conn,
    content="JWT tokens should use RS256 algorithm for better security",
    embedding=embedding_vector,  # numpy array, shape (768,)
    project_id="uuid",
    task_id=None,
    system_id=None,
    created_by="orchestrator",
    categories=["security", "authentication"]
)

# Semantic search
results = await mgr.search(
    conn,
    embedding=query_vector,
    project_id="uuid",           # Optional filter
    categories=["security"],     # Optional filter
    top_k=5
)
# Returns: [(memory_id, similarity_score), ...]

# Update feedback
await mgr.update_feedback(conn, memory_id, feedback=3)  # Range: -5 to +5
```

### 7.3 Repository Embedding Pipeline

The `embed_repo.py` script processes repositories for the memory system:

```bash
python memory/embed_repo.py \
    --repo-path /home/user/projects/myrepo \
    --project-id <uuid> \
    --db-host localhost \
    --db-port 5432 \
    --db-name knowledge_manager \
    --db-user km_user \
    --db-password <password> \
    --code-model microsoft/codebert-base \
    --text-model BAAI/bge-base-en-v1.5 \
    --batch-size 8
```

**Processing pipeline:**
1. Recursively walk repository tree
2. Classify files by extension (code vs. prose)
3. Chunk content into overlapping segments (1024 chars, 128 overlap)
4. Generate embeddings using appropriate model (CodeBERT for code, BGE for text)
5. Store embeddings in `memory_items` table with project association

### 7.4 Vector Search Implementation

The `PgVectorStore` class wraps pgvector operations:

```python
# Cosine similarity search (lower distance = higher similarity)
query = """
    SELECT memory_id, 1.0 - (embedding <-> $1) AS similarity
    FROM memory_items
    WHERE project_id = $2
    ORDER BY embedding <-> $1
    LIMIT 5
"""
```

---

## 8. API Reference

### 8.1 Orchestrator REST API (Port 8000)

#### Health & Status

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /` | GET | Service info (name, version, status) |
| `GET /health` | GET | Health check with database connection status |
| `GET /stats` | GET | System statistics (task counts, project count) |

#### Tasks

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /tasks` | GET | List tasks (query params: `status`, `limit`) |
| `POST /tasks/queue` | POST | Submit task to filesystem queue |

**POST /tasks/queue Body:**
```json
{
  "project_id": "uuid",
  "title": "Task title",
  "description": "Task description",
  "cli_preference": "claude",
  "priority": 3,
  "working_dir": "/optional/path"
}
```

#### Model Configuration

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /config/models` | GET | List available models and current selection |
| `POST /config/models/select` | POST | Set active model |

**Available Models:**
- `claude-3-5-sonnet` (Anthropic)
- `claude-3-opus` (Anthropic)
- `gpt-4.1-mini` (OpenAI)
- `qwen2.5-coder-32b` (Local/RTX 5090)

#### Project Tracking

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /projects/tracking` | GET | List all projects with tracking metadata |
| `GET /projects/{id}/tracking` | GET | Get tracking details for specific project |
| `POST /projects/{id}/tracking` | POST | Update tracking configuration |
| `POST /projects/{id}/tracking/index` | POST | Queue embedding job |

**POST /projects/{id}/tracking Body:**
```json
{
  "repo_path": "/path/to/repo",
  "repo_paths": ["/path1", "/path2"],
  "is_tracked": true,
  "embedding_status": "pending",
  "preferred_model_id": "claude-3-5-sonnet",
  "embedding_model_id": "qwen2.5-coder-32b",
  "gpu_enabled": true,
  "gpu_device": "cuda:0",
  "notes": "Optional notes"
}
```

#### Memory Operations

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /memory/items` | GET | List memories (filters: `project_id`, `category`, `search`) |
| `GET /memory/stats` | GET | Memory statistics (total, by project, by category) |
| `DELETE /memory/items/{id}` | DELETE | Delete specific memory |
| `POST /memory/feedback` | POST | Update memory feedback score |
| `POST /memory/search` | POST | Semantic search with embedding vector |

**POST /memory/search Body:**
```json
{
  "embedding": [0.1, 0.2, ...],  // 768-dimensional vector
  "project_id": "optional-uuid",
  "categories": ["optional", "filters"],
  "top_k": 5
}
```

---

## 9. CLI Workers

### 9.1 Claude Worker Script

**Location:** `cli_integrations/claude_worker.sh`

The Claude worker handles task execution with comprehensive error handling:

```bash
#!/bin/bash
# Usage: claude_worker.sh <task-id>

# 1. Read task from assigned/ directory
# 2. Move to in_progress/ with PID and timestamp
# 3. Change to working directory
# 4. Take file snapshot (for change detection)
# 5. Execute: timeout $TIMEOUT claude "$DESCRIPTION"
# 6. Capture stdout/stderr
# 7. Calculate duration
# 8. Detect modified files
# 9. Copy artifacts to results/
# 10. Create summary file
# 11. Move to completed/ or failed/
```

**Exit Code Handling:**
- `0`: Success → `completed/`
- `124`: Timeout → `failed/` with TimeoutError
- `127`: Command not found → `failed/` with CommandNotFoundError
- Other: Execution error → `failed/` with exit code

### 9.2 Worker Configuration

Environment variables:
- `TASK_QUEUE_PATH`: Root directory for task queue
- `TASK_TIMEOUT`: Maximum execution time in seconds (default: 1800)

### 9.3 Future Workers

Planned implementations for:
- `codex_worker.sh` - OpenAI Codex CLI
- `gemini_worker.sh` - Google Gemini CLI
- Generic worker with CLI parameter selection

---

## 10. Configuration and Deployment

### 10.1 Environment Variables

**PostgreSQL:**
```bash
POSTGRES_HOST=localhost          # or "postgres" in container
POSTGRES_PORT=5432
POSTGRES_USER=km_user
POSTGRES_PASSWORD=<secure>
POSTGRES_DB=knowledge_manager
```

**Orchestrator:**
```bash
LOG_LEVEL=INFO
WORKER_THREADS=4
TASK_POLL_INTERVAL=5             # seconds
TASK_QUEUE_PATH=/app/task_queue  # or host path
```

**LLM Router:**
```bash
LLAMA_CPP_HOST=host.docker.internal
LLAMA_CPP_PORT=8080
```

**kmtui (Knowledge Manager TUI):**
```bash
KM_DB_TYPE=postgresql
KM_POSTGRES_HOST=localhost
KM_POSTGRES_PORT=5432
KM_POSTGRES_DB=knowledge_manager
KM_POSTGRES_USER=km_user
KM_POSTGRES_PASSWORD=<secure>
```

### 10.2 Docker Compose Configuration

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    container_name: km-postgres
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-km_user}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB:-knowledge_manager}
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./docker/postgres/init-scripts:/docker-entrypoint-initdb.d:ro
    networks:
      - km-network
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER}"]
      interval: 10s
      timeout: 5s
      retries: 5

  orchestrator:
    build:
      context: .
      dockerfile: docker/orchestrator/Dockerfile
    container_name: km-orchestrator
    environment:
      POSTGRES_HOST: postgres
      POSTGRES_PORT: 5432
      POSTGRES_USER: ${POSTGRES_USER:-km_user}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB:-knowledge_manager}
      TASK_QUEUE_PATH: /app/task_queue
    ports:
      - "8000:8000"
    volumes:
      - ./task_queue:/app/task_queue        # Bind mount for host access
      - ./logs:/app/logs
    networks:
      - km-network
    depends_on:
      postgres:
        condition: service_healthy
    extra_hosts:
      - "host.docker.internal:host-gateway"

volumes:
  postgres_data:
    external: true
    name: docker_postgres_data

networks:
  km-network:
    driver: bridge
```

### 10.3 Quick Start Commands

```bash
# Build and start all services
./build_all.sh

# Or manually:
docker compose up -d

# Watch logs
docker compose logs -f orchestrator

# Rebuild after code changes
docker compose build orchestrator && docker compose up -d orchestrator

# Check status
docker compose ps
curl http://localhost:8000/health

# View task queue
ls -la task_queue/*/
```

---

## 11. Key Workflows

### 11.1 End-to-End Task Execution

```
1. Start orchestrator:
   $ cd ~/projects/ai-orchestrator && docker compose up -d

2. Open kmtui in another terminal:
   $ kmtui

3. Create or select a task in kmtui

4. Press Ctrl+A to assign task to AI queue
   → Task JSON written to task_queue/queued/

5. Orchestrator detects task (within 5 seconds)
   → Moves to task_queue/assigned/
   → Spawns claude_worker.sh process

6. Worker executes:
   → Moves to task_queue/in_progress/
   → Runs: claude "<task description>"
   → Captures output to task_queue/results/<task-id>/

7. Worker completes:
   → Moves to task_queue/completed/ or failed/
   → Results available for inspection

8. View results:
   $ cat task_queue/results/<task-id>/output.txt
```

### 11.2 Project Memory Indexing

```
1. In Web UI or via API, update project tracking:
   POST /projects/{id}/tracking
   {
     "is_tracked": true,
     "repo_path": "/home/user/projects/myrepo"
   }

2. Trigger embedding job:
   POST /projects/{id}/tracking/index
   {
     "scope": "both",
     "force_reindex": false
   }

3. Task created in queue for embed_repo.py

4. Worker runs embedding pipeline on GPU

5. Memories stored in memory_items table

6. Future tasks can query relevant context:
   POST /memory/search
   {
     "embedding": <query_vector>,
     "project_id": "{id}",
     "top_k": 5
   }
```

### 11.3 Multi-Device Access

```
1. Configure PostgreSQL for LAN access:
   $ ./scripts/setup_network_postgres.sh

2. On other devices, set environment:
   export KM_DB_TYPE=postgresql
   export KM_POSTGRES_HOST=192.168.50.100  # xeres IP
   export KM_POSTGRES_PORT=5432
   export KM_POSTGRES_DB=knowledge_manager
   export KM_POSTGRES_USER=km_user
   export KM_POSTGRES_PASSWORD=<password>

3. Run kmtui - connects to shared database

4. Device registration happens automatically on first connection
```

---

## 12. Current Implementation Status

### 12.1 Completed Features ✅

| Component | Status | Notes |
|-----------|--------|-------|
| PostgreSQL with pgvector | ✅ Complete | Running in Docker, schema initialized |
| Orchestrator service | ✅ Complete | FastAPI, async polling, LISTEN/NOTIFY |
| Task queue filesystem | ✅ Complete | Atomic operations, all status directories |
| Claude worker script | ✅ Complete | Real CLI execution, timeout, artifacts |
| kmtui integration | ✅ Complete | Ctrl+A assigns tasks |
| Memory schema | ✅ Complete | Tables, indexes, vector search |
| Project tracking | ✅ Complete | API endpoints, embedding status |
| Monitoring TUI | ✅ Basic | Dashboard, worker grid, activity log |

### 12.2 In Progress 🚧

| Component | Status | Next Steps |
|-----------|--------|------------|
| Database sync | 🚧 Partial | Workers update filesystem; need PostgreSQL sync |
| Multi-CLI support | 🚧 Design | codex_worker.sh, gemini_worker.sh |
| Embedding pipeline | 🚧 Partial | GPU indexing works; needs task queue integration |

### 12.3 Planned ⏳

| Component | Priority | Description |
|-----------|----------|-------------|
| LLM router | High | Route simple tasks to local llama.cpp |
| Web UI | Medium | Browser-based monitoring dashboard |
| Retention policies | Medium | Memory eviction based on usage/feedback |
| Cost tracking | Low | Track API token usage per task |
| Task dependencies | Low | DAG-based execution ordering |

---

## 13. Development Roadmap

### Phase 4.5: Database Synchronization (Next)
- Add PostgreSQL updates to worker scripts
- Sync task status between filesystem and database
- Enable kmtui to show real-time completion status

### Phase 5: Multiple CLI Support
- Create generic worker script with CLI parameter
- Add codex and gemini worker implementations
- Implement worker pool limits per CLI type
- Add fallback logic (if primary CLI unavailable)

### Phase 6: LLM Router (RTX 5090)
- Implement llama.cpp client
- Add task complexity detection
- Route simple tasks to local models
- Configure model hot-swapping

### Phase 7: Vector Database & RAG
- Automatic embedding on repository changes
- RAG pipeline for task context injection
- Memory relevance scoring

### Phase 8: Web UI
- FastAPI + Svelte/React frontend
- WebSocket for real-time updates
- Task submission and management
- Memory browser

---

## 14. Troubleshooting Guide

### 14.1 Orchestrator Issues

**Problem:** Orchestrator stuck in loop finding same tasks

**Cause:** Task queue directory structure malformed

**Solution:**
```bash
cd ~/projects/ai-orchestrator/task_queue
rm -rf '{queued,assigned,in_progress,completed,failed,results}'  # Remove if exists
mkdir -p queued assigned in_progress completed failed results
docker compose build orchestrator && docker compose up -d orchestrator
```

**Problem:** PostgreSQL connection failed

**Solution:**
```bash
# Check PostgreSQL is running
docker compose ps postgres

# Verify connection from container
docker compose exec orchestrator python -c "import asyncpg; print('OK')"

# Check environment variables
docker compose exec orchestrator env | grep POSTGRES
```

### 14.2 Worker Issues

**Problem:** Tasks stuck in `assigned/` state

**Cause:** Worker script not executable or not found

**Solution:**
```bash
chmod +x cli_integrations/claude_worker.sh
ls -la cli_integrations/
```

**Problem:** `claude` command not found

**Solution:** Ensure Claude Code CLI is installed and in PATH:
```bash
which claude
# Install if missing: pipx install claude-cli (or equivalent)
```

### 14.3 Database Issues

**Problem:** Vector search returns no results

**Cause:** Embeddings not created or wrong dimension

**Solution:**
```sql
-- Check memory_items count
SELECT COUNT(*) FROM memory_items;

-- Verify embedding dimension
SELECT vector_dims(embedding) FROM memory_items LIMIT 1;
-- Should return 768
```

---

## 15. Glossary

| Term | Definition |
|------|------------|
| **kmtui** | Knowledge Manager Terminal UI - the primary human interface for managing projects and tasks |
| **kmorch** | Orchestrator viewer TUI - monitoring dashboard for active workers |
| **Task Queue** | Filesystem-based queue for AI task coordination |
| **Worker** | Process that executes CLI commands (claude, codex, gemini) |
| **Memory Item** | Persisted knowledge with vector embedding for semantic search |
| **pgvector** | PostgreSQL extension enabling vector similarity search |
| **LISTEN/NOTIFY** | PostgreSQL pub/sub mechanism for real-time updates |
| **Project Tracking** | Metadata associating projects with repositories and embedding status |
| **Embedding** | Dense vector representation of text for semantic similarity |
| **RAG** | Retrieval-Augmented Generation - injecting relevant context into prompts |

---

## Document Maintenance

This briefing should be updated when:
- Major architectural changes occur
- New API endpoints are added
- Database schema changes
- New components are implemented

**Version History:**
- 1.0 (January 2026): Initial comprehensive briefing

---

*End of AI Orchestrator Briefing Document*
