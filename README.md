# AI Orchestrator - Multi-Agent Task Management System

A distributed system for orchestrating AI agents, managing tasks, and coordinating between human users and multiple LLMs/CLIs.

> **📖 Documentation:** This README covers daily operations. See [GOALS.md](GOALS.md) for roadmap and [docs/CURRENT_STATE.md](docs/CURRENT_STATE.md) for current status.

## Quick Reference

```bash
# Build + start everything with one command
./build/build_all.sh

# Build + start everything with helper script
./build/start.sh

# Start all dockerized services
cd ~/projects/ai-orchestrator && docker compose up -d

# Watch logs
docker compose logs -f orchestrator

# Stop everything
./build/stop.sh

# Rebuild everything (stop + start)
./build/rebuild.sh

# Check status
docker compose ps
curl http://localhost:8000/health

# View task queue
ls -la ~/projects/ai-orchestrator/task_queue/*/

# Web UI (koweb)
docker compose up -d koweb
# Open http://localhost:3001

# LM Studio (local server)
# Default LM Studio port is 1234; configured via LLAMA_CPP_PORT in docker-compose.yml.

# LM Studio bridge (host-side control service)
./lms_bridge/bridge.sh start
./lms_bridge/bridge.sh status
export KO_WEB_LMS_BRIDGE_URL=http://localhost:5080

# Show Docker info
./build/info.sh
```

`./build/build_all.sh` builds and starts the full Docker stack defined in
[`docker-compose.yml`](docker-compose.yml): `postgres`, `orchestrator`, and
`koweb`.

`docker compose up -d` also starts the full stack from `docker-compose.yml`
unless you name a specific service.

**End-to-End Usage:**
1. Start services: `cd ~/projects/ai-orchestrator && docker compose up -d`
2. Open kmtui: `kmtui` (in another terminal)
3. Select a task and press `Ctrl+A` to assign to AI
4. Watch orchestrator logs: `docker compose logs -f orchestrator`
5. Check results: `cat task_queue/results/<task-id>/output.txt`

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Host System                              │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ kmtui        │  │ claude CLI   │  │ codex CLI    │          │
│  │ (Human UI)   │  │              │  │              │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
│         │                 │                  │                   │
│         │                 │                  │                   │
│  ┌──────▼──────────────────▼──────────────────▼───────┐         │
│  │         PostgreSQL (Port 5432)                      │         │
│  │         ┌──────────────────────┐                    │         │
│  │         │  LISTEN/NOTIFY       │                    │         │
│  │         │  'task_updates'      │                    │         │
│  │         └──────────────────────┘                    │         │
│  └──────────────────────┬──────────────────────────────┘         │
│                         │                                         │
│  ┌──────────────────────▼──────────────────────────────┐         │
│  │         AI Orchestrator (Port 8000)                  │         │
│  │         ┌──────────────────────┐                     │         │
│  │         │ Task Dispatcher      │                     │         │
│  │         │ Worker Pool          │                     │         │
│  │         │ LLM Router           │                     │         │
│  │         └──────────────────────┘                     │         │
│  └──────────────────────┬──────────────────────────────┘         │
│                         │                                         │
│  ┌──────────────────────▼──────────────────────────────┐         │
│  │  RTX 5090 LLMs / LM Studio (default Port 1234)      │         │
│  │  - Qwen models                                       │         │
│  │  - Local inference                                   │         │
│  └──────────────────────────────────────────────────────┘         │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

## Components

### 1. PostgreSQL Database (Docker)
- **Purpose**: Centralized data store for projects, tasks, and metadata
- **Location**: Docker container
- **Access**: Available to both host CLIs and orchestrator
- **Features**:
  - LISTEN/NOTIFY for real-time updates
  - UUID primary keys
  - ENUM types for status fields
  - Triggers for automatic timestamp updates

### 2. AI Orchestrator (Docker)
- **Purpose**: Task dispatcher and coordinator
- **Technology**: Python FastAPI
- **Responsibilities**:
  - Monitor task queue via LISTEN/NOTIFY
  - Dispatch tasks to appropriate workers (CLIs or LLMs)
  - Manage task lifecycle and status
  - Route requests to RTX 5090 LLMs
  - Provide REST API for monitoring

### 3. knowledge_manager TUI (Host)
- **Purpose**: Human-facing interface for task/project management
- **Location**: Installed from ~/scripts repo as `kmtui` CLI
- **Access**: Connects directly to PostgreSQL
- **Features**:
  - Create/edit projects and tasks
  - View task hierarchy
  - Cross-project task linking
  - Real-time updates via LISTEN/NOTIFY

### 4. External CLIs (Host)
- **Claude Code**: `claude` command
- **OpenAI Codex**: `codex` command
- **Gemini**: `gemini` command
- **Location**: Host system (not in Docker)
- **Reason**: Need filesystem access, git operations, etc.

### 5. RTX 5090 LLMs (Host)
- **Purpose**: Local LLM inference
- **Technology**: llama.cpp server
- **Models**: Qwen, etc.
- **Location**: Host system
- **Access**: Orchestrator connects via host.docker.internal

## Data Flow

### Task Creation Flow
```
User creates task in kmtui
    ↓
Insert into PostgreSQL
    ↓
PostgreSQL fires NOTIFY 'task_updates'
    ↓
Orchestrator receives notification
    ↓
Orchestrator evaluates task requirements
    ↓
Dispatches to appropriate worker:
    - External CLI (via filesystem queue)
    - Local LLM (via llama.cpp API)
```

### Task Status Update Flow
```
Worker completes task
    ↓
Updates PostgreSQL via API or direct connection
    ↓
PostgreSQL fires NOTIFY 'task_updates'
    ↓
Both kmtui and orchestrator receive update
    ↓
UI refreshes, orchestrator logs completion
```

## Quick Start

### Prerequisites
- Docker and Docker Compose
- Python 3.11+ (for host tools)
- PostgreSQL client (psql)
- knowledge_manager installed from scripts repo (`kmtui` command)

### Initial Setup (One-time)

```bash
# 1. Navigate to repo
cd ~/projects/ai-orchestrator

# 2. Create environment file
cp docker/.env.example .env
nano .env  # Set POSTGRES_PASSWORD

# 3. Create Docker volume for PostgreSQL data (if not exists)
docker volume create docker_postgres_data

# 4. Configure kmtui environment variables
# Add to ~/.zshrc or ~/.bashrc:
export KM_DB_TYPE=postgresql
export KM_POSTGRES_HOST=localhost
export KM_POSTGRES_PORT=5432
export KM_POSTGRES_DB=knowledge_manager
export KM_POSTGRES_USER=km_user
export KM_POSTGRES_PASSWORD=<your_password>

# 5. Start services for first time
docker compose up -d

# 6. Verify everything works
docker compose ps  # Should show postgres, orchestrator, and koweb as running
curl http://localhost:8000/health  # Should return {"status":"healthy"}
```

## Daily Operations

### Starting the Stack

```bash
# Start all dockerized services (PostgreSQL + Orchestrator + koweb)
cd ~/projects/ai-orchestrator
docker compose up -d

# Or start just orchestrator (if PostgreSQL already running)
docker compose up -d orchestrator
```

**What happens:**
- PostgreSQL starts and waits for connections
- Orchestrator waits for PostgreSQL health check to pass
- Orchestrator connects to database and starts polling task queue
- koweb starts and connects to the orchestrator API
- API becomes available at http://localhost:8000
- Web UI becomes available at http://localhost:3001

### Watching the Orchestrator

```bash
# View live logs (follows output, Ctrl+C to exit)
cd ~/projects/ai-orchestrator
docker compose logs -f orchestrator

# View last 50 lines of logs
docker compose logs --tail=50 orchestrator

# View logs from all services
docker compose logs -f

# Check service status
docker compose ps
```

**What you'll see in logs:**
```
km-orchestrator  | Starting AI Orchestrator...
km-orchestrator  | Database connection pool created
km-orchestrator  | Task queue initialized at /app/task_queue
km-orchestrator  | Task processor started - polling task queue...
km-orchestrator  | Application startup complete.
```

### Stopping the Orchestrator

```bash
# Stop all services
cd ~/projects/ai-orchestrator
docker compose down

# Stop but keep containers (faster restart)
docker compose stop

# Stop just orchestrator (keep PostgreSQL running)
docker compose stop orchestrator
```

### Restarting After Code Changes

```bash
cd ~/projects/ai-orchestrator

# 1. Rebuild orchestrator container
docker compose build orchestrator

# 2. Recreate and restart
docker compose up -d orchestrator

# 3. Watch logs to verify
docker compose logs -f orchestrator
```

### Using the System (End-to-End Workflow)

**Step 1: Start the stack**
```bash
cd ~/projects/ai-orchestrator
docker compose up -d
docker compose logs -f orchestrator  # Keep this running in a terminal
```

**Step 2: Open kmtui**
```bash
# In another terminal
kmtui
```

**Step 3: Create or select a task**
- Navigate to Tasks screen in kmtui
- Select an existing task or create a new one

**Step 4: Assign task to AI**
- Press `Ctrl+A` while task is selected
- kmtui writes task to `task_queue/queued/`

**Step 5: Watch orchestrator process the task**
In the orchestrator logs terminal, you'll see:
```
Found 1 queued tasks
Assigning task abc123 to claude
Spawned claude worker (PID: 1234)
```

**Step 6: Check task progress**
```bash
# View task queue directories
ls -la ~/projects/ai-orchestrator/task_queue/*/

# Task moves through:
# queued/ → assigned/ → in_progress/ → completed/ or failed/

# View task results
cat ~/projects/ai-orchestrator/task_queue/results/<task-id>/output.txt
```

**Step 7: Task completes**
- Worker updates task status in PostgreSQL
- kmtui shows task as completed
- Results available in `task_queue/results/`

## Development

### Project Structure

```
ai-orchestrator/
├── docker/
│   ├── orchestrator/          # Orchestrator service
│   │   ├── Dockerfile
│   │   ├── main.py            # FastAPI application
│   │   └── requirements.txt
│   └── postgres/
│       └── init-scripts/      # Schema initialization
├── cli_integrations/          # CLI wrappers (TODO)
│   ├── claude_cli.py
│   └── codex_cli.py
├── llm_router/                # LLM management (TODO)
│   └── llama_cpp_client.py
├── shared/                    # Shared utilities (TODO)
│   ├── messaging.py           # LISTEN/NOTIFY client
│   └── task_queue.py
├── docs/                      # Documentation
│   ├── CURRENT_STATE.md
│   ├── NEXT_STEPS.md
│   └── archive/
├── docker-compose.yml         # Main compose file
└── README.md
```

### API Endpoints

The orchestrator exposes a REST API:

- `GET /` - Service info
- `GET /health` - Health check
- `GET /tasks?status=todo&limit=100` - Get tasks
- `GET /stats` - System statistics

### Database Access

```bash
# Connect to PostgreSQL
docker compose exec postgres psql -U km_user -d knowledge_manager

# Run queries
SELECT * FROM projects;
SELECT * FROM tasks WHERE status = 'todo';
```

## Communication Patterns

### LISTEN/NOTIFY (Real-time)
- PostgreSQL triggers send notifications on INSERT/UPDATE/DELETE
- Both orchestrator and kmtui subscribe to `task_updates` channel
- JSON payload includes operation type, table, ID, and data

### Task Queue (Filesystem)
- Orchestrator writes task files to `/app/task_queue` (Docker volume)
- Host CLIs monitor queue directory for new tasks
- Results written back to queue for orchestrator to process

### REST API (Monitoring)
- Orchestrator exposes HTTP API for status monitoring
- External tools can query task status, statistics
- Web UI is available via `koweb` at `http://localhost:3001`

## Integration with scripts Repo

The `knowledge_manager` module remains installed from `~/scripts`:

```bash
# From scripts repo
cd ~/scripts
python setup.py  # Installs kmtui command

# kmtui is now available system-wide
kmtui  # Launches TUI, connects to PostgreSQL
```

**Key Point**: The `kmtui` CLI is the **human interface** to the database. The orchestrator is the **AI interface** to the database. Both use PostgreSQL as the single source of truth.

---

## Project Documentation

- **[GOALS.md](GOALS.md)** - Roadmap and strategic direction
- **[docs/CURRENT_STATE.md](docs/CURRENT_STATE.md)** - Current operational state
- **[docs/NEXT_STEPS.md](docs/NEXT_STEPS.md)** - Short active execution list
- **[docs/CONTAINERIZATION_STRATEGY.md](docs/CONTAINERIZATION_STRATEGY.md)** - Architecture decisions
- **[docs/TASK_QUEUE_DESIGN.md](docs/TASK_QUEUE_DESIGN.md)** - Task queue system design
- **[docs/archive/](docs/archive/)** - Archived historical plans and superseded docs

---

## Troubleshooting

### Orchestrator Stuck in Loop ("Found X pending tasks" repeating)

**Problem:** Orchestrator finds tasks but doesn't process them

**Solution:**
```bash
# Check task queue directory structure
ls -la ~/projects/ai-orchestrator/task_queue/

# Should see: queued/, assigned/, in_progress/, completed/, failed/, results/
# If you see weird directory names like {queued,assigned,...}, fix it:

cd ~/projects/ai-orchestrator/task_queue
rm -rf '{queued,assigned,in_progress,completed,failed,results}'
mkdir -p queued assigned in_progress completed failed results

# Rebuild and restart orchestrator
cd ~/projects/ai-orchestrator
docker compose build orchestrator
docker compose up -d orchestrator
```

### PostgreSQL Connection Issues

```bash
# 1. Check PostgreSQL is running
docker compose ps postgres
# Should show: "Up" and "healthy"

# 2. View PostgreSQL logs
docker compose logs postgres

# 3. Test connection from inside container
docker compose exec postgres psql -U km_user -d knowledge_manager -c "SELECT 1"

# 4. Test connection from host
psql -h localhost -p 5432 -U km_user -d knowledge_manager

# 5. Check environment variables
docker compose exec orchestrator env | grep POSTGRES
```

**Common fixes:**
- Ensure `POSTGRES_PASSWORD` is set in `docker/.env`
- Check PostgreSQL port 5432 is not already in use: `lsof -i :5432`
- Verify Docker volume exists: `docker volume ls | grep postgres_data`

### Orchestrator Not Starting

```bash
# 1. View detailed logs
docker compose logs --tail=100 orchestrator

# 2. Check for Python errors
docker compose logs orchestrator | grep -i error

# 3. Verify orchestrator can reach PostgreSQL
docker compose exec orchestrator ping postgres

# 4. Check if orchestrator has access to task_queue
docker compose exec orchestrator ls -la /app/task_queue/
```

**Common issues:**
- `ModuleNotFoundError`: Rebuild container (`docker compose build orchestrator`)
- Database connection failed: Check PostgreSQL is healthy first
- Task queue not found: Check bind mount in docker-compose.yml

### kmtui Not Connecting to PostgreSQL

```bash
# 1. Verify environment variables are set
echo $KM_DB_TYPE          # Should be: postgresql
echo $KM_POSTGRES_HOST    # Should be: localhost
echo $KM_POSTGRES_PORT    # Should be: 5432

# 2. Test PostgreSQL connection from host
psql -h localhost -p 5432 -U km_user -d knowledge_manager

# 3. Check if variables are in your shell config
grep KM_POSTGRES ~/.zshrc   # or ~/.bashrc
```

**Solution:** Add to `~/.zshrc` or `~/.bashrc`:
```bash
export KM_DB_TYPE=postgresql
export KM_POSTGRES_HOST=localhost
export KM_POSTGRES_PORT=5432
export KM_POSTGRES_DB=knowledge_manager
export KM_POSTGRES_USER=km_user
export KM_POSTGRES_PASSWORD=<your_password>
```

Then reload: `source ~/.zshrc`

### Tasks Not Moving Through Queue

```bash
# 1. Check task queue permissions
ls -la ~/projects/ai-orchestrator/task_queue/

# 2. Verify orchestrator is polling
docker compose logs --tail=20 orchestrator | grep "Task processor"

# 3. Manually check for tasks
ls ~/projects/ai-orchestrator/task_queue/queued/

# 4. Check worker script exists
ls -la ~/projects/ai-orchestrator/cli_integrations/claude_worker.sh
```

**Common issues:**
- Task files have wrong permissions: `chmod 644 task_queue/queued/*.json`
- Worker script not executable: `chmod +x cli_integrations/claude_worker.sh`
- Orchestrator polling stopped: Restart orchestrator

### Clean Slate (Nuclear Option)

If everything is broken and you want to start fresh:

```bash
cd ~/projects/ai-orchestrator

# 1. Stop all services
docker compose down

# 2. Remove containers and volumes (WARNING: deletes all data!)
docker compose down -v

# 3. Clean task queue
rm -rf task_queue/*
mkdir -p task_queue/{queued,assigned,in_progress,completed,failed,results}

# 4. Recreate PostgreSQL volume
docker volume rm docker_postgres_data
docker volume create docker_postgres_data

# 5. Start fresh
docker compose up -d

# 6. Watch initialization
docker compose logs -f
```

### Getting Help

```bash
# Check container resource usage
docker stats

# Inspect orchestrator container
docker compose exec orchestrator bash

# View full docker-compose configuration
docker compose config

# Check Docker network
docker network ls | grep km-network
docker network inspect km-network
```

## License

MIT

## Contributing

This is a personal project for managing AI-assisted development workflows.
