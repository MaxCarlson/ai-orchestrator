# Web UI Design - AI Orchestrator & Knowledge Manager

**Created:** 2025-12-31
**Purpose:** Unified web interface for orchestrator monitoring and knowledge management

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Browser (Any Device on LAN)               │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                    Web UI (React/Svelte)                │ │
│  │  ┌──────────────┐           ┌──────────────────────┐  │ │
│  │  │ Orchestrator │           │ Knowledge Manager    │  │ │
│  │  │ Monitor      │ ◄────────►│ (Tasks/Projects)     │  │ │
│  │  │              │           │                      │  │ │
│  │  │ - Workers    │           │ - Projects List      │  │ │
│  │  │ - Tasks      │           │ - Tasks Grid         │  │ │
│  │  │ - Live Logs  │           │ - Task Details       │  │ │
│  │  │ - Stats      │           │ - Create/Edit        │  │ │
│  │  └──────┬───────┘           └──────────┬───────────┘  │ │
│  │         │                              │              │ │
│  │         └──────────────┬───────────────┘              │ │
│  │                        │                              │ │
│  │           ┌────────────▼────────────┐                 │ │
│  │           │  WebSocket (Real-time)  │                 │ │
│  │           │  REST API (CRUD)        │                 │ │
│  │           └────────────┬────────────┘                 │ │
│  └────────────────────────┼──────────────────────────────┘ │
└────────────────────────────┼────────────────────────────────┘
                             │
                    ┌────────▼────────┐
                    │   Web Server    │
                    │   (FastAPI)     │
                    │   Port: 3000    │
                    └────┬───────┬────┘
                         │       │
        ┌────────────────┘       └──────────────┐
        │                                       │
┌───────▼────────┐                    ┌─────────▼──────────┐
│  PostgreSQL    │                    │  Task Queue FS     │
│  - Projects    │                    │  - queued/         │
│  - Tasks       │                    │  - in_progress/    │
│  - Status      │                    │  - completed/      │
└────────────────┘                    │  - results/        │
                                      └────────────────────┘
```

---

## Technology Stack

### Backend
- **FastAPI** - Python web framework
  - REST API endpoints
  - WebSocket support
  - Async/await for PostgreSQL
  - CORS for LAN access
- **PostgreSQL** - Data source
  - LISTEN/NOTIFY for real-time updates
  - asyncpg for connection pool
- **Task Queue** - Filesystem monitoring
  - Watch for changes via polling or inotify

### Frontend
- **Svelte** (recommended) or React
  - Lightweight, fast
  - Component-based
  - Built-in reactivity
- **WebSocket** - Real-time updates
- **Tailwind CSS** - Styling
- **Chart.js** - Graphs and stats

### Deployment
- **Docker Container** - Web server
- **Bind Mounts** - Task queue access
- **Network Bridge** - Connect to PostgreSQL
- **Port 3000** - Exposed on LAN

---

## Page Structure

### 1. Dashboard (Home)
**URL:** `/`

**Layout:**
```
┌─────────────────────────────────────────────────────────┐
│  [AI Orchestrator]        [Dashboard] [Orchestrator]    │
│                                      [Knowledge Manager] │
├─────────────────────────────────────────────────────────┤
│  Quick Stats                                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ Active       │  │ Completed    │  │ Failed       │ │
│  │ Workers: 2   │  │ Today: 15    │  │ Today: 1     │ │
│  └──────────────┘  └──────────────┘  └──────────────┘ │
├─────────────────────────────────────────────────────────┤
│  Recent Activity                                        │
│  ┌─────────────────────────────────────────────────┐   │
│  │ 01:32 - Task "Fix auth bug" completed           │   │
│  │ 01:30 - Worker claude-1 started task            │   │
│  │ 01:28 - New task "Add logging" queued           │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 2. Orchestrator Monitor
**URL:** `/orchestrator`

**Sections:**
- **Worker Grid** (top)
  - Card for each active worker
  - Shows: PID, task, progress, duration
  - Color-coded by status
- **Task Queue** (middle)
  - Columns: Queued, Assigned, In Progress, Completed, Failed
  - Drag cards between columns (visual only)
- **Live Logs** (bottom)
  - Streaming output from active workers
  - Filter by worker or task
  - Auto-scroll toggle

**Layout:**
```
┌─────────────────────────────────────────────────────────┐
│  Workers (2 active)                                     │
│  ┌──────────────────┐  ┌──────────────────┐           │
│  │ claude-worker-1  │  │ codex-worker-1   │           │
│  │ Task: Fix auth   │  │ Task: Add tests  │           │
│  │ Duration: 2m15s  │  │ Duration: 45s    │           │
│  │ [=========>   ]  │  │ [==>          ]  │           │
│  └──────────────────┘  └──────────────────┘           │
├─────────────────────────────────────────────────────────┤
│  Task Queue                                             │
│  [Queued: 3]  [Assigned: 2]  [Progress: 2]  [Done: 15] │
├─────────────────────────────────────────────────────────┤
│  Live Logs                        [Auto-scroll] [Clear] │
│  ┌─────────────────────────────────────────────────┐   │
│  │ [01:32:15] claude-worker-1: Analyzing task...   │   │
│  │ [01:32:18] claude-worker-1: Generating code...  │   │
│  │ [01:32:22] codex-worker-1: Running tests...     │   │
│  │ ▼                                                │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 3. Knowledge Manager
**URL:** `/tasks`

**Sections:**
- **Project Selector** (sidebar)
- **Tasks Grid** (main)
  - Sortable columns: Title, Status, Priority, Due Date
  - Filter by status, priority
  - Search by title
- **Task Detail Panel** (right or modal)
  - Title, description, markdown details
  - Status, priority, dates
  - Assign to AI button
  - Edit inline

**Layout:**
```
┌───────────────┬─────────────────────────────────────────┐
│ Projects      │ Tasks (Scripts Repo)                    │
│               │ [Search...] [Filter] [New Task]         │
│ ► Scripts     ├─────────────────────────────────────────┤
│   Dotfiles    │ Title              Status    Priority   │
│   AI Orch     │ ─────────────────────────────────────── │
│               │ □ Fix auth bug     Done      High       │
│               │ □ Add logging      Todo      Medium     │
│               │ ☑ Update docs      Done      Low        │
│               │                                         │
│               │ [Selected: Fix auth bug]                │
│               │ Description: ...                        │
│               │ [Assign to AI] [Edit]                   │
└───────────────┴─────────────────────────────────────────┘
```

### 4. Task Detail View
**URL:** `/tasks/:id`

**Sections:**
- Task metadata (title, status, priority, dates)
- Markdown details editor
- Execution history (if assigned to AI)
- Results viewer (if completed)

---

## REST API Endpoints

### Orchestrator API

```
GET  /api/orchestrator/workers          # List active workers
GET  /api/orchestrator/tasks            # List tasks by status
GET  /api/orchestrator/stats            # System statistics
GET  /api/orchestrator/logs/:task_id    # Get task logs
POST /api/orchestrator/cancel/:task_id  # Cancel running task
```

### Knowledge Manager API

```
GET    /api/projects                    # List all projects
GET    /api/projects/:id                # Get project details
POST   /api/projects                    # Create project
PUT    /api/projects/:id                # Update project
DELETE /api/projects/:id                # Delete project

GET    /api/tasks                       # List tasks (with filters)
GET    /api/tasks/:id                   # Get task details
POST   /api/tasks                       # Create task
PUT    /api/tasks/:id                   # Update task
DELETE /api/tasks/:id                   # Delete task
POST   /api/tasks/:id/assign            # Assign task to AI queue
```

### Results API

```
GET /api/results/:task_id               # Get task execution results
GET /api/results/:task_id/logs          # Get stdout/stderr
GET /api/results/:task_id/artifacts     # List modified files
GET /api/results/:task_id/artifacts/:path # Download artifact
```

---

## WebSocket Protocol

### Connection
```
ws://localhost:3000/ws
```

### Messages (Server → Client)

**Worker Status Update:**
```json
{
  "type": "worker_status",
  "data": {
    "worker_id": "claude-worker-1",
    "status": "running",
    "task_id": "abc123",
    "task_title": "Fix auth bug",
    "started_at": "2025-12-31T02:00:00Z",
    "duration_seconds": 135
  }
}
```

**Task Queue Update:**
```json
{
  "type": "task_update",
  "data": {
    "task_id": "abc123",
    "status": "in_progress",
    "assigned_to": "claude-worker-1"
  }
}
```

**Log Stream:**
```json
{
  "type": "log",
  "data": {
    "task_id": "abc123",
    "worker_id": "claude-worker-1",
    "timestamp": "2025-12-31T02:00:15Z",
    "level": "info",
    "message": "Analyzing task requirements..."
  }
}
```

**Task Completed:**
```json
{
  "type": "task_complete",
  "data": {
    "task_id": "abc123",
    "status": "completed",
    "duration_seconds": 135,
    "files_modified": 3,
    "result_path": "/results/abc123/"
  }
}
```

### Messages (Client → Server)

**Subscribe to Task:**
```json
{
  "type": "subscribe",
  "task_id": "abc123"
}
```

**Unsubscribe:**
```json
{
  "type": "unsubscribe",
  "task_id": "abc123"
}
```

---

## Real-time Updates Strategy

### PostgreSQL LISTEN/NOTIFY
- Web server subscribes to `task_updates` channel
- When tasks are created/updated in PostgreSQL:
  - Trigger fires `NOTIFY task_updates`
  - Web server receives notification
  - Broadcasts to WebSocket clients

### Task Queue Filesystem
- Poll task queue directories every 2 seconds
- Detect changes (new files, moved files, updated files)
- Broadcast updates to WebSocket clients

### Worker Process Monitoring
- Track spawned worker PIDs
- Poll worker status (running, completed, failed)
- Broadcast worker status updates

---

## File Structure

```
ai-orchestrator/
├── web_ui/                    # NEW - Web UI service
│   ├── backend/
│   │   ├── main.py           # FastAPI server
│   │   ├── api/
│   │   │   ├── orchestrator.py
│   │   │   ├── knowledge.py
│   │   │   └── results.py
│   │   ├── websocket/
│   │   │   ├── manager.py    # WebSocket connection manager
│   │   │   └── handlers.py   # Message handlers
│   │   ├── models.py         # Pydantic models
│   │   └── requirements.txt
│   ├── frontend/
│   │   ├── src/
│   │   │   ├── App.svelte
│   │   │   ├── pages/
│   │   │   │   ├── Dashboard.svelte
│   │   │   │   ├── Orchestrator.svelte
│   │   │   │   └── Tasks.svelte
│   │   │   ├── components/
│   │   │   │   ├── WorkerCard.svelte
│   │   │   │   ├── TaskQueue.svelte
│   │   │   │   ├── LiveLogs.svelte
│   │   │   │   └── TaskDetail.svelte
│   │   │   └── stores/
│   │   │       ├── websocket.js
│   │   │       └── tasks.js
│   │   ├── package.json
│   │   └── vite.config.js
│   ├── Dockerfile
│   └── docker-compose.override.yml
```

---

## Docker Integration

### New Service in docker-compose.yml

```yaml
  web_ui:
    build:
      context: .
      dockerfile: web_ui/Dockerfile
    container_name: km-web-ui
    restart: unless-stopped
    environment:
      POSTGRES_HOST: postgres
      POSTGRES_PORT: 5432
      POSTGRES_USER: ${POSTGRES_USER:-km_user}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB:-knowledge_manager}
      TASK_QUEUE_PATH: /app/task_queue
    ports:
      - "${WEB_UI_PORT:-3000}:3000"
    volumes:
      - ./task_queue:/app/task_queue:ro  # Read-only access
      - ./logs:/app/logs:ro
    networks:
      - km-network
    depends_on:
      postgres:
        condition: service_healthy
```

### Access URLs

- **Local:** http://localhost:3000
- **LAN:** http://<your-ip>:3000 (e.g., http://192.168.1.100:3000)
- **From phone/tablet:** Same LAN URL

---

## Development Plan

### Phase 1: Backend Setup (2-3 hours)
1. Create FastAPI server with basic routes
2. Add PostgreSQL connection pool
3. Implement REST API for tasks/projects
4. Add WebSocket manager
5. Test with curl/Postman

### Phase 2: Real-time Updates (2 hours)
1. Subscribe to PostgreSQL LISTEN/NOTIFY
2. Poll task queue filesystem
3. Broadcast updates via WebSocket
4. Test with wscat

### Phase 3: Frontend Scaffolding (2 hours)
1. Set up Svelte project with Vite
2. Create page structure (Dashboard, Orchestrator, Tasks)
3. Add routing (svelte-routing)
4. Basic styling with Tailwind

### Phase 4: Orchestrator Monitor (3 hours)
1. Worker grid component
2. Task queue visualization
3. Live logs component
4. WebSocket integration

### Phase 5: Knowledge Manager Interface (3 hours)
1. Projects sidebar
2. Tasks grid with filters
3. Task detail panel
4. Create/edit forms
5. Assign to AI functionality

### Phase 6: Polish & Deploy (2 hours)
1. Error handling
2. Loading states
3. Responsive design
4. Docker deployment
5. LAN access testing

**Total Effort:** ~14-16 hours

---

## Security Considerations

### Authentication (Future)
- Currently no auth (LAN-only access)
- Future: JWT tokens, session management
- Read-only mode for guests

### CORS
- Allow LAN IP range
- Restrict to specific origins in production

### Rate Limiting
- Prevent API abuse
- Limit WebSocket connections per IP

---

## Success Criteria

✅ Can access web UI from any device on LAN
✅ Real-time worker monitoring (no refresh needed)
✅ Live log streaming from active workers
✅ Can create/edit tasks via web UI
✅ Can assign tasks to AI queue
✅ Can view task execution results
✅ Responsive design (works on phone/tablet)
✅ < 100ms WebSocket latency
✅ Handles 10+ concurrent workers

---

**Next Steps:**
1. Create backend FastAPI server
2. Add PostgreSQL integration
3. Implement WebSocket manager
4. Build frontend Svelte app
5. Deploy in Docker container
