# Containerization Strategy - AI Orchestrator

**Created**: 2025-12-29
**Purpose**: Define what runs in Docker vs host, and how they communicate

---

## Architecture Decision

### What Runs WHERE and WHY

```
┌─────────────────────────────────────────────────────────────────────┐
│                         HOST (WSL2 Ubuntu)                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  USER INTERFACES & GPU SERVICES (Must be on host)                   │
│  ┌──────────┐    ┌─────────────┐    ┌──────────────────────────┐   │
│  │  kmtui   │    │ CLI Tools   │    │  RTX 5090 / llama.cpp   │   │
│  │          │    │ - claude    │    │  - Qwen models          │   │
│  │ Terminal │    │ - codex     │    │  - Code embeddings      │   │
│  │ TUI      │    │ - gemini    │    │  - GPU required         │   │
│  └────┬─────┘    └──────┬──────┘    └──────────┬──────────────┘   │
│       │                 │                       │                   │
│       │                 │                       │                   │
│  ┌────▼─────────────────▼───────────────────────▼────────────────┐ │
│  │          SHARED FILESYSTEM (Volume Mounts)                     │ │
│  │  ~/projects/ai-orchestrator/task_queue/                        │ │
│  │  ~/projects/ai-orchestrator/logs/                              │ │
│  │  ~/projects/ai-orchestrator/config/                            │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │               DOCKER NETWORK (km-network)                      │  │
│  │                                                                 │  │
│  │  ┌─────────────────┐         ┌──────────────────────────┐    │  │
│  │  │  Orchestrator   │◄────────┤   PostgreSQL 16          │    │  │
│  │  │  (FastAPI)      │  async  │   + pgvector             │    │  │
│  │  │                 │  pool   │                          │    │  │
│  │  │  Port: 8000     │         │   Port: 5432             │    │  │
│  │  │  Volumes:       │         │   Volume: postgres_data  │    │  │
│  │  │  - task_queue   │         │                          │    │  │
│  │  │  - logs         │         │   Databases:             │    │  │
│  │  └─────────────────┘         │   - knowledge_manager    │    │  │
│  │                               │   - knowledge_manager_   │    │  │
│  │                               │     test                 │    │  │
│  │                               └──────────────────────────┘    │  │
│  │                                                                 │  │
│  │  Optional (Future):                                            │  │
│  │  ┌─────────────────┐                                           │  │
│  │  │   pgAdmin       │  (profile: admin)                         │  │
│  │  │   Port: 5050    │                                           │  │
│  │  └─────────────────┘                                           │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Container Breakdown

### Container 1: PostgreSQL (km-postgres)
**Status**: ✅ Already implemented
**Purpose**: Central database for all data

**Configuration**:
- Image: `postgres:16`
- Ports: `5432:5432`
- Volumes:
  - `postgres_data:/var/lib/postgresql/data` (external volume)
  - `./docker/postgres/init-scripts:/docker-entrypoint-initdb.d:ro`
- Network: `km-network`
- Healthcheck: `pg_isready`

**Databases**:
- `knowledge_manager` - Production data
- `knowledge_manager_test` - Test isolation

**Extensions**:
- `pgvector` - Vector embeddings for memory system
- `pgcrypto` - Cryptographic functions

---

### Container 2: Orchestrator (km-orchestrator)
**Status**: ⏳ Code written, needs containerization
**Purpose**: Task dispatcher and coordinator

**Dockerfile** (`docker/orchestrator/Dockerfile`):
```dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    jq \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements
COPY docker/orchestrator/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy shared modules
COPY shared/ /app/shared/

# Copy orchestrator code
COPY docker/orchestrator/ /app/

# Expose API port
EXPOSE 8000

# Run orchestrator
CMD ["python", "main.py"]
```

**Configuration**:
- Build: `./docker/orchestrator`
- Ports: `8000:8000`
- Volumes:
  - `task_queue:/app/task_queue` (bind mount to host)
  - `./logs:/app/logs`
  - `./config:/app/config:ro`
- Network: `km-network`
- Depends on: `postgres` (healthy)
- Extra hosts: `host.docker.internal:host-gateway` (access host CLIs)

**Environment Variables**:
```bash
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_USER=km_user
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=knowledge_manager
LOG_LEVEL=INFO
WORKER_THREADS=4
TASK_POLL_INTERVAL=5
LLAMA_CPP_HOST=host.docker.internal
LLAMA_CPP_PORT=8080
TASK_QUEUE_PATH=/app/task_queue
```

---

### Container 3: pgAdmin (km-pgadmin) - Optional
**Status**: ✅ Already implemented
**Purpose**: Database management UI

**Configuration**:
- Image: `dpage/pgadmin4:latest`
- Ports: `5050:80`
- Profile: `admin` (only starts with `docker compose --profile admin up`)
- Network: `km-network`

---

## What Stays on Host

### 1. kmtui (Terminal UI)
**Why**: Needs direct terminal access, uses host Python venv

**Access Pattern**:
- Writes to task queue: `~/projects/ai-orchestrator/task_queue/queued/`
- Reads from PostgreSQL: `localhost:5432`
- Configuration: `~/.zshrc` env vars

### 2. CLI Workers (claude, codex, gemini)
**Why**:
- These are host-installed tools (`claude` command via pipx, etc.)
- Need access to host filesystem
- May need host SSH keys, credentials

**Execution**:
- Spawned by orchestrator via `host.docker.internal`
- Read/write task queue (shared volume)
- Execute on host, update results

**Alternative** (Future): Run CLI workers in sidecar containers with credential mounting

### 3. RTX 5090 / llama.cpp Server
**Why**:
- GPU passthrough to Docker is complex
- Better performance on host
- Direct CUDA access

**Access Pattern**:
- Listens on: `localhost:8080`
- Accessible from orchestrator: `http://host.docker.internal:8080`

---

## Volume Strategy

### Volume 1: postgres_data (Docker named volume)
**Type**: External, persistent
**Purpose**: PostgreSQL database files
**Created**: `docker volume create docker_postgres_data`
**Backup**: Regular pg_dump to host

### Volume 2: task_queue (Bind mount)
**Type**: Host directory bind mount
**Purpose**: Task queue filesystem
**Location**: `~/projects/ai-orchestrator/task_queue`
**Shared**: Host + Orchestrator container

**Why bind mount**:
- Host CLIs need write access
- Orchestrator needs read/write access
- Easy inspection from host
- No permission issues

**Structure**:
```
task_queue/
├── queued/          # kmtui writes here
├── assigned/        # Orchestrator moves here
├── in_progress/     # Workers update here
├── completed/       # Final state
├── failed/          # Error state
└── results/         # Worker output
    └── <task-id>/
        ├── stdout.log
        ├── stderr.log
        └── artifacts/
```

### Volume 3: logs (Bind mount)
**Type**: Host directory
**Purpose**: Orchestrator logs
**Location**: `~/projects/ai-orchestrator/logs`

### Volume 4: config (Bind mount, read-only)
**Type**: Host directory
**Purpose**: Configuration files
**Location**: `~/projects/ai-orchestrator/config`

---

## Network Strategy

### Docker Network: km-network
**Type**: Bridge
**Purpose**: Internal communication between containers

**Accessible from host**:
- PostgreSQL: `localhost:5432`
- Orchestrator API: `localhost:8000`
- pgAdmin: `localhost:5050`

**Accessible from containers**:
- PostgreSQL: `postgres:5432`
- Orchestrator: `orchestrator:8000`

### Host Access from Containers
**Method**: `host.docker.internal` (Docker Desktop / WSL2)

**Use cases**:
- Orchestrator → llama.cpp: `http://host.docker.internal:8080`
- Orchestrator → Host CLIs: SSH or direct exec via volume

---

## Security Considerations

### Secrets Management
**Current**: Environment variables in `.env`
**Future**: Docker secrets or HashiCorp Vault

**Never commit**:
- `.env` files
- Database passwords
- API keys

### Container Isolation
- Containers run as non-root user (TODO)
- Read-only root filesystem where possible (TODO)
- Resource limits (memory, CPU) (TODO)

### Network Security
- Only expose necessary ports
- Use internal network for container-to-container
- Consider firewall rules for production

---

## Development Workflow

### Starting Everything
```bash
cd ~/projects/ai-orchestrator

# Start core services
docker compose up -d postgres orchestrator

# Check health
docker compose ps
docker compose logs -f orchestrator

# Start with admin tools
docker compose --profile admin up -d
```

### Development Iteration
```bash
# Rebuild orchestrator after code changes
docker compose build orchestrator
docker compose up -d orchestrator

# View logs
docker compose logs -f orchestrator

# Restart single service
docker compose restart orchestrator
```

### Debugging
```bash
# Shell into orchestrator
docker compose exec orchestrator bash

# Check task queue from container
docker compose exec orchestrator ls -la /app/task_queue

# Check database connection
docker compose exec orchestrator python -c "
from shared.task_queue import TaskQueue
q = TaskQueue()
print(q.get_queue_stats())
"
```

### Cleanup
```bash
# Stop all services
docker compose down

# Stop and remove volumes (WARNING: deletes data)
docker compose down -v

# Remove only orchestrator
docker compose rm -f orchestrator
```

---

## Migration Plan

### Phase 1: Containerize Orchestrator (NOW)
- [x] Create Dockerfile for orchestrator
- [ ] Update docker-compose.yml with orchestrator service
- [ ] Test orchestrator in container
- [ ] Verify task queue access from container
- [ ] Verify PostgreSQL connection

### Phase 2: Test End-to-End (NEXT)
- [ ] Start orchestrator in Docker
- [ ] Submit task from kmtui (host)
- [ ] Verify orchestrator picks up task
- [ ] Verify worker spawns on host
- [ ] Verify results written to shared volume
- [ ] Verify task moves to completed/

### Phase 3: Worker Execution Strategy (SOON)
**Option A**: Orchestrator spawns workers on host via SSH
```python
# In orchestrator container
subprocess.run([
    "ssh", "localhost",  # SSH to host
    "bash", "/path/to/claude_worker.sh", task_id
])
```

**Option B**: Orchestrator writes "worker request" file, host daemon picks up
```python
# Orchestrator writes:
# task_queue/worker_requests/<task-id>.json

# Host daemon (systemd service) polls and spawns:
# bash claude_worker.sh <task-id>
```

**Option C**: CLI workers as containers (complex credential mounting)

**Recommendation**: Start with Option B (simpler, no SSH setup)

### Phase 4: Production Hardening (LATER)
- [ ] Add resource limits to containers
- [ ] Implement health checks for orchestrator
- [ ] Add restart policies
- [ ] Set up log rotation
- [ ] Configure backups (PostgreSQL, task queue)
- [ ] Add monitoring (Prometheus/Grafana)

---

## File Structure (Updated)

```
ai-orchestrator/
├── docker-compose.yml           # Multi-service orchestration
├── .env                         # Environment secrets (gitignored)
├── .env.example                 # Template
├── docker/
│   ├── orchestrator/
│   │   ├── Dockerfile           # NEW: Orchestrator container
│   │   ├── main.py             # FastAPI app
│   │   ├── requirements.txt    # Python deps
│   │   └── .dockerignore       # NEW
│   └── postgres/
│       └── init-scripts/
│           └── 01_init_schema.sql
├── shared/
│   └── task_queue.py           # Shared by host + container
├── cli_integrations/
│   └── claude_worker.sh        # Runs on HOST
├── task_queue/                 # SHARED (bind mount)
│   ├── queued/
│   ├── assigned/
│   ├── in_progress/
│   ├── completed/
│   ├── failed/
│   └── results/
├── logs/                       # SHARED (bind mount)
├── config/                     # SHARED (bind mount, ro)
└── docs/
    ├── CONTAINERIZATION_STRATEGY.md  # This file
    └── TASK_QUEUE_DESIGN.md
```

---

## Next Steps (Immediate)

1. **Create Dockerfile** for orchestrator
2. **Update docker-compose.yml** with orchestrator service
3. **Test build**: `docker compose build orchestrator`
4. **Test run**: `docker compose up orchestrator`
5. **Verify**:
   - Orchestrator starts without errors
   - Connects to PostgreSQL
   - Can access task queue at `/app/task_queue`
   - API responds at `localhost:8000`
6. **End-to-end test**: kmtui → orchestrator → worker → results

---

## Questions to Resolve

1. **Worker spawning**: SSH to host vs worker request files vs sidecar containers?
2. **CLI credentials**: How do containerized workers access host SSH keys / API tokens?
3. **GPU access**: Keep llama.cpp on host or attempt GPU passthrough?
4. **Scaling**: Single orchestrator or multiple worker containers?

**Recommendation**: Start simple (orchestrator in Docker, workers on host), iterate later

---

**End of Strategy Document**
