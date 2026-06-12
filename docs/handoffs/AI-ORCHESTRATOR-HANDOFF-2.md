# AI Orchestrator — Session Handoff #2

**Date:** 2026-06-11  
**Picking up from:** `AI-ORCHESTRATOR-HANDOFF.md` (session #1 doc, still accurate)

---

## What Was Accomplished This Session

### 1. Docker Stack — Rebuilt & Healthy
All 4 containers are running:
```
km-postgres       pgvector/pgvector:pg16   :5432   healthy
km-orchestrator   ai-orchestrator          :8000   healthy
km-chat-server    ai-orchestrator-chat     :8765   up
km-koweb          ai-orchestrator-koweb    :3001   up
```
Rebuild sequence: `bash build/rebuild.sh` → `bash build/start.sh`

### 2. New API Endpoint: `POST /projects`
Added to `docker/orchestrator/main.py`. Creates a `projects` row + `project_tracking` row in one transaction.

**Model added:** `ProjectCreate(name, description, repo_path, gpu_enabled, gpu_device, notes)`

**Full project endpoint list now:**
```
POST /projects                          ← NEW (this session)
GET  /projects/tracking
GET  /projects/{project_id}/tracking
POST /projects/{project_id}/tracking
POST /projects/{project_id}/tracking/index
```

### 3. `bin/orch` CLI — Created & Working
Python stdlib-only CLI at `bin/orch`. Commands:
- `project register -n NAME [--cwd] [--gpu] [-r PATH]` → `POST /projects`, writes `.kmproj`
- `project list` → `GET /projects/tracking`
- `project info NAME_OR_ID`
- `project set-repo PROJECT_ID REPO_PATH`
- `project index PROJECT_ID [-m auto|code|text]` → `POST /projects/{id}/tracking/index`
- `task list [-l N]` → `GET /tasks/queue`  (note: actual endpoint is `GET /tasks`)
- `stats` → health + memory stats

**Usage:** `python3 bin/orch <command>` or `uv run bin/orch <command>` from repo root.  
Uses `ORCH_URL` env var (default: `http://localhost:8000`).

### 4. ai-orchestrator Registered as a Project
```
project_id:  ba8f2b31-e5d6-4a5e-bf40-d51c016a495e
name:        ai-orchestrator
repo_path:   /home/mcarls/projects/ai-orchestrator
is_tracked:  True
gpu_enabled: True
```
`.kmproj` file written to repo root.

### 5. Project `.venv` Created with uv
```bash
uv venv .venv --python 3.13          # .venv at repo root
uv pip install -e ".[dev]"           # all deps installed, exit 0
```
`pyproject.toml` created at repo root covering host-side deps:
- asyncpg, psycopg2-binary
- numpy, sentence-transformers, torch (GPU)
- langchain stack, rank-bm25
- openai, anthropic, httpx
- pytest, ruff, black, mypy (dev)

**The `.venv` Python to use for all host-side work:**
```bash
source .venv/bin/activate
# or directly:
.venv/bin/python memory/run_embeddings.py ...
```

---

## Current State / What Was NOT Done Yet

### asyncpg C-extension pollution (global pyenv)
During this session, `torch`, `sentence-transformers`, `numpy` were accidentally installed into the **global pyenv 3.13.7** environment (before the .venv was created). Those packages are now duplicated there. This is harmless but messy — a future cleanup would be:
```bash
~/.pyenv/versions/3.13.7/bin/pip uninstall torch sentence-transformers numpy triton
```

### Indexing Not Yet Started
The `POST /projects/{id}/tracking/index` endpoint queues a task to `task_queue/queued/` — it does **not** run immediately. The task queue flow requires:
1. Orchestrator queues task → `task_queue/queued/<uuid>.json`
2. Something assigns it → `task_queue/assigned/<uuid>.json`
3. Local worker picks it up → executes `memory/run_embeddings.py`

**The local worker loop (`bin/local_worker_loop.sh`) was never started.** It watches `assigned/`, not `queued/`. There is no auto-assignment mechanism — tasks sit in `queued/` indefinitely until assigned.

**To actually run indexing, next session should:**
```bash
# Option A: Direct execution (fastest, bypasses task queue entirely)
source .venv/bin/activate
POSTGRES_PASSWORD=$(grep POSTGRES_PASSWORD .env | cut -d= -f2 | tr -d '"') \
python memory/run_embeddings.py \
  --project-id ba8f2b31-e5d6-4a5e-bf40-d51c016a495e \
  --repo-path /home/mcarls/projects/ai-orchestrator \
  --mode both \
  --target project \
  --db-host localhost --db-port 5432 \
  --db-name knowledge_manager --db-user km_user \
  --db-password "$POSTGRES_PASSWORD"

# Option B: Through task queue (requires assigning + running worker)
python3 bin/orch project index ba8f2b31-e5d6-4a5e-bf40-d51c016a495e
# Then check queued/:
ls task_queue/queued/
# Manually assign (move file):
mv task_queue/queued/<uuid>.json task_queue/assigned/<uuid>.json
# Run worker:
bash bin/local_worker_loop.sh
```

Option A is recommended for first run — simpler, easier to debug output.

### `bin/orch task list` Has a Bug
The `cmd_task_list` function in `bin/orch` calls `GET /tasks/queue` but the actual endpoint is `GET /tasks`. Fix:
```python
# In bin/orch, cmd_task_list():
resp = api("GET", "/tasks")   # not /tasks/queue
```

---

## Immediate Next Steps (Priority Order)

1. **Fix `bin/orch task list`** — change endpoint from `/tasks/queue` to `/tasks`

2. **Run first indexing** — use Option A above (direct `run_embeddings.py`) to get chunks into DB

3. **Verify chunks exist:**
   ```bash
   PGPASSWORD=$(grep POSTGRES_PASSWORD .env | cut -d= -f2 | tr -d '"') \
   psql -h localhost -U km_user -d knowledge_manager \
     -c "SELECT COUNT(*) FROM code_chunks WHERE project_id = 'ba8f2b31-e5d6-4a5e-bf40-d51c016a495e';"
   ```

4. **Test code search:**
   ```bash
   curl -s -X POST http://localhost:8000/memory/code-search/ba8f2b31-e5d6-4a5e-bf40-d51c016a495e \
     -H 'Content-Type: application/json' \
     -d '{"query": "task queue", "limit": 5}' | python3 -m json.tool
   ```

5. **P3 work (after indexing confirmed):**
   - Add `kind TEXT NOT NULL DEFAULT 'project_fact'` column to `memory_items` / `global_memory_items` in `memory/models.py`
   - Add `kinds` filter to `hybrid_search()` in `memory/retrieval.py`
   - Wire context injection in `chat/src/QueryEngine.ts`

---

## Environment Quick Reference

| Thing | Value |
|-------|-------|
| Orchestrator API | `http://localhost:8000` |
| Health check | `curl http://localhost:8000/health` |
| Web UI | `http://localhost:3001` |
| LM Studio API | `http://localhost:1234/v1` |
| Project venv | `.venv/bin/python` (uv-managed) |
| Project ID | `ba8f2b31-e5d6-4a5e-bf40-d51c016a495e` |
| DB | `postgresql://km_user@localhost:5432/knowledge_manager` |
| DB password | In `.env` as `POSTGRES_PASSWORD` |
| lms binary | `~/.lmstudio/bin/lms` |
| Preferred model | `qwen/qwen3-30b-a3b` (18.6GB, fits in 32GB VRAM) |
| Avoid | `qwen/qwen3-coder-next` (80B, doesn't fit, 2min TTFT) |

## Start Stack
```bash
cd /home/mcarls/projects/ai-orchestrator
bash build/start.sh      # build + up
bash build/rebuild.sh    # stop + build + up
bash build/stop.sh       # down
docker compose logs -f orchestrator
```

## Key Files Changed This Session
| File | Change |
|------|--------|
| `docker/orchestrator/main.py` | Added `ProjectCreate` model + `POST /projects` endpoint |
| `bin/orch` | New file — project management CLI |
| `pyproject.toml` | New file — root project config for uv/pip |
| `.venv/` | New — uv-managed Python 3.13 venv |
| `.kmproj` | New — project ID marker file |
| `chat/src/commands/config.ts` | Default model → `qwen/qwen3-30b-a3b` |
| `lms_bridge/app.py` | LMS binary default → `lms` (not `lms.exe`) |
| `lms_bridge/run.sh` | Binary resolution order fixed |
