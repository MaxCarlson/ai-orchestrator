# AI Orchestrator - Multi-Agent Task Management System

A distributed system for orchestrating AI agents, managing tasks, and coordinating between human users and multiple LLMs/CLIs.

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
│  │  RTX 5090 LLMs (llama.cpp on Port 8080)             │         │
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

## Setup Instructions

### Prerequisites
- Docker and Docker Compose
- Python 3.11+ (for host tools)
- PostgreSQL client (psql)
- knowledge_manager installed from scripts repo

### 1. Clone and Configure

```bash
cd /home/mcarls/projects/ai-orchestrator
cp docker/.env.example docker/.env
nano docker/.env  # Set POSTGRES_PASSWORD
```

### 2. Start Services

```bash
# Start PostgreSQL and Orchestrator
docker compose up -d

# View logs
docker compose logs -f orchestrator

# Check health
curl http://localhost:8000/health
```

### 3. Configure knowledge_manager

The `kmtui` command from scripts repo needs to connect to PostgreSQL instead of SQLite:

```bash
# Set environment variables
export KM_DB_TYPE=postgresql
export KM_POSTGRES_HOST=localhost
export KM_POSTGRES_PORT=5432
export KM_POSTGRES_DB=knowledge_manager
export KM_POSTGRES_USER=km_user
export KM_POSTGRES_PASSWORD=<your_password>

# Or add to ~/.zshrc / ~/.bashrc
```

### 4. Run Migration (if needed)

```bash
# If migrating from existing SQLite database
cd docker
pgloader migrate.load
```

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
│   ├── POSTGRESQL_MIGRATION_STATUS.md
│   └── BRIEFING_FOR_NEXT_SESSION.md
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
- Future: Web UI for system dashboard

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

## Next Steps

### Phase 4: DB Adapter Updates
- [ ] Update `knowledge_manager/db.py` for PostgreSQL support
- [ ] Add environment variable detection (SQLite vs PostgreSQL)
- [ ] Test kmtui with PostgreSQL backend

### Phase 5: CLI Integrations
- [ ] Create wrappers for claude, codex, gemini CLIs
- [ ] Implement filesystem task queue
- [ ] Add result parsing and status updates

### Phase 6: LLM Router
- [ ] llama.cpp client implementation
- [ ] Model loading and unloading logic
- [ ] Request routing based on task requirements

### Phase 7: Vector Database
- [ ] Set up vector store for project context
- [ ] RAG pipeline for task augmentation
- [ ] Context management system

## Troubleshooting

### PostgreSQL Connection Issues
```bash
# Check PostgreSQL is running
docker compose ps postgres

# View PostgreSQL logs
docker compose logs postgres

# Test connection
docker compose exec postgres psql -U km_user -d knowledge_manager -c "SELECT 1"
```

### Orchestrator Not Starting
```bash
# Check environment variables
docker compose exec orchestrator env | grep POSTGRES

# View orchestrator logs
docker compose logs -f orchestrator

# Restart services
docker compose restart orchestrator
```

### kmtui Not Connecting
```bash
# Verify environment variables
echo $KM_DB_TYPE
echo $KM_POSTGRES_HOST

# Test PostgreSQL from host
psql -h localhost -p 5432 -U km_user -d knowledge_manager
```

## License

MIT

## Contributing

This is a personal project for managing AI-assisted development workflows.
