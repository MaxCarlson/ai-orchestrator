# AI Orchestrator — LLM Handoff Report

**Date:** 2026-06-11  
**Repo:** `/home/mcarls/projects/ai-orchestrator` (branch: `main`, clean working tree)  
**Purpose:** Bring an incoming LLM fully up to speed on this repo with zero discovery waste.

---

## Executive Summary

This is a self-managing AI orchestration platform: a FastAPI + PostgreSQL hub that coordinates human users, multiple LLM/CLI workers, and long-lived vector memory so tasks move from idea → execution → verification with minimal babysitting.

**Current focus (as of last session):** The core infrastructure is already built. The remaining work is *proof and integration*, not new design:

1. Verify a local LM Studio model can answer end-to-end through `aioc`.
2. Run the first real code/text embedding job for this repo.
3. Wire retrieved memory context into the chat prompt pipeline.


+**Do not rebuild:** pgvector schema, code/text chunk tables, hybrid retrieval (dense + BM25 + RRF + reranker), text/code ingestion endpoints, LM Studio provider routing — all exist.

---

## Trust Order for Documentation

| Priority | File | Use For |
|---|---|---|
| **1** | `docs/CURRENT_STATE.md` | Definitive operational snapshot |
| **1** | `docs/NEXT_STEPS.md` | Active P1/P2/P3 task list |
| **1** | `memory/README.md` | Memory subsystem architecture |
| **1** | `memory/PLAN.md` | Memory integration roadmap (hands-on tasks) |
| **2** | `GOALS.md` | Mission, principles, end-state vision |
| **2** | `README.md` | Quick commands, env setup, running services |
| **3** | `docs/RAG_ACTION_PLAN.md` | Historical; partially superseded by code |
| **3** | `docs/RAG_PIPELINE_*.md` | Historical pipeline designs |
| **3** | `ai-orchestrator-briefing.md` | Old context brief; use this doc instead |
| **3** | `docs/archive/*` | Archived; do not rely on |

---

## Repo Map by Subsystem

### Docker / Runtime (`docker-compose.yml`, `build/`)

Four services in `docker-compose.yml`:

| Container | Image / Build | Port | Role |
|---|---|---|---|
| `km-postgres` | `pgvector/pgvector:pg16` | 5432 | PostgreSQL + pgvector, single source of truth |
| `km-orchestrator` | `docker/orchestrator/Dockerfile` | 8000 | FastAPI task dispatcher, memory API |
| `km-chat-server` | `docker/chat/Dockerfile` | 8765 | Bun/TypeScript WebSocket chat server |
| `km-koweb` | `docker/koweb/Dockerfile` | 3001 | Orchestrator Web Viewer |

Volume notes:
- `task_queue/` → bind-mounted to `/app/task_queue` in both orchestrator and koweb
- `logs/` → bind-mounted to `/app/logs` in orchestrator
- `postgres_data` → **external** named volume (`docker_postgres_data`, shared with `knowledge_manager`)

`LLAMA_CPP_PORT` is mapped to 1234, not 8080 — LM Studio default port. The env var name is legacy from llama.cpp days but points at LM Studio.

Build/start scripts live in `build/`:
- `build/start.sh` — `docker compose build` + `up -d` + koweb restart guard + `lms_bridge/bridge.sh start`
- `build/stop.sh` — `docker compose down --remove-orphans` + stops bridge
- `build/rebuild.sh` — stop then start
- `build/build_all.sh` — full `--pull` rebuild  
- `build/info.sh` — `docker compose ps`, images, volumes, networks

Health check: `curl http://localhost:8000/health`, `curl -I http://localhost:3001`

---

### Chat / Local LLM (`chat/`, `bin/aioc`, `lms_bridge/`)

**`chat/`** — Bun/TypeScript REPL + WebSocket server

Key files:
- `chat/src/QueryEngine.ts` — Core engine. `submit()` routes by model prefix: `gemini-*` → Gemini backend, `claude-*` → Anthropic, `gpt-*/o1-*/o3-*` → OpenAI cloud, anything else → LM Studio (OpenAI-compat at `localUrl`). Calls `ensureLmStudio()` for local models before the first request.
- `chat/src/server.ts` — Bun WebSocket server exposing `/ws/chat`. Launched via `aioc --serve`.
- `chat/src/cli.ts` — CLI entrypoint (`aioc`). Accepts `--serve`, `--model`, `--no-embeddings`, working dir args.
- `chat/src/commands/embeddings.ts` — `/embeddings on|off|status` command. **Currently only toggles an in-memory flag (`embeddingsEnabled`). Does NOT yet call the orchestrator's `/memory/search` endpoint. This is the P3 wiring gap.**
- `chat/src/project/context.ts` — Project context state: `embeddingsEnabled` (defaults to `true`), project info.
- `chat/src/backends/lmstudio.ts` — `ensureLmStudio()`: checks LM Studio readiness, optionally starts it.

Typecheck/test:
```bash
cd chat && ~/.bun/bin/bun run typecheck
cd chat && ~/.bun/bin/bun test
```

**`bin/aioc`** — Shell wrapper that launches `chat/src/cli.ts` via Bun.

**`lms_bridge/`** — Small FastAPI HTTP bridge on port 5080. Wraps `lms.exe` CLI (LM Studio's command-line interface) so the web UI can control the local model server (load model, list loaded, etc.). Uses `subprocess.run` against `lms.exe`. `bridge.sh` manages start/stop as a background process.

---

### Memory / RAG (`memory/`)

**Schema** (`memory/models.py`):

| Table | Purpose | Embedding Dim |
|---|---|---|
| `code_chunks` / `global_code_chunks` | AST-chunked Python symbols | 768 (CodeBERT) |
| `text_chunks` / `global_text_chunks` | Prose/doc chunks | 768 (BGE) |
| `memory_items` | Durable named memories (decisions, notes) | varies |
| `global_memory_items` | Cross-project memories | varies |
| `project_text_sources` | Registry of ingested source files | — |
| `embedding_models` | Model registry (BGE, CodeBERT, ms-marco) | — |
| `embedding_runs` | Audit log of indexing jobs | — |
| `categories` / `memory_categories` | Category tagging | — |

**`memory/retrieval.py`** — Primary retrieval interface. Call `hybrid_search()` for all new retrieval.
- `dense_search()` — pgvector cosine (`<=>` operator)  
- BM25 sparse via `rank-bm25`, 5-minute in-process TTL cache  
- `_rrf_merge()` — Reciprocal Rank Fusion (k=60)  
- `hybrid_search()` — dense + BM25 + RRF + optional CrossEncoder reranking → top-k  
- `invalidate_bm25_cache(table, owner_column, owner_id)` — scoped invalidation; call after any ingest

**`memory/code_indexer.py`** — Incremental hash-based indexer. Skips files whose content hash matches existing `code_chunks` rows. Takes `--repo-path`, `--project-id`, DB connection args.

**`memory/run_embeddings.py`** — **Unified runner** that calls both `index_repository` (code) and `index_text_documents` (text). Accepts `--mode auto|code|text` and `--target project|global|both`. Already routes through `index_text_documents` — a prior doc claim that this was missing is **stale**.

**`memory/ingest_pipeline.py`** — `index_text_documents()`: LangChain-based text/doc ingest with per-file chunk reconciliation (detects new, updated, deleted chunks). Supersedes the old text-mode logic in `embed_repo.py`.

**`memory/source_ingestion.py`** — Tracks ingested files in `project_text_sources`. Supports `.md/.txt/.rst/.pdf/.json/.ndjson`. Key functions: `ingest_bytes_as_source`, `ingest_uploaded_files`, `list_project_sources`, `reingest_project_source`, `replace_project_source`, `delete_project_source`. Invalidates BM25 cache after ingest.

**`memory/manager.py`** — `MemoryManager` API over `memory_items`: `add_memory`, `search`, `update_feedback`, `initialize_schema`.

---

### Orchestrator API (`docker/orchestrator/main.py`)

FastAPI service at port 8000. Key endpoint groups:

**Health & Tasks:**
- `GET /health` — liveness check
- Task queue endpoints — file-based state machine (`queued/ → assigned/ → in_progress/ → completed/|failed/`)

**Memory endpoints (already implemented):**
- `POST /memory/search` — hybrid search over `memory_items`
- `POST /memory/search-text` — hybrid search over `text_chunks` for a project
- `POST /memory/global/search-text` — same, global scope
- `POST /memory/code-search/{project_id}` — vector search over `code_chunks`
- `POST /memory/code-index/{project_id}` — queues local worker task to run code indexer
- `POST /memory/text-index/{project_id}` — queues local worker task to run text indexer
- `POST /memory/ingest-text/{project_id}` — direct text ingest (no file upload needed)
- `POST /memory/upload-files/{project_id}` — multipart file upload + ingest
- `POST /memory/global/index` — queues global indexing job
- `GET /memory/sources/{project_id}` — list ingested sources
- `DELETE /memory/sources/{project_id}/{source_id}` — remove a source
- `POST /memory/sources/{project_id}/{source_id}/reingest` — re-process a source
- `GET /memory/items` — list memory_items
- `POST /memory/items` — create memory item
- `DELETE /memory/items/{memory_id}` — delete memory item
- `POST /memory/feedback` — record user feedback
- `GET /memory/embedding-runs` — list indexing job history
- `GET /memory/stats` — count stats per project
- `GET /memory/global/stats` — global stats

**Important:** `POST /memory/code-index/{project_id}` queues a **local worker task**, meaning it only works if `bin/local_worker_loop.sh` is running on the host **and** the repo path is accessible on the host (not just in the container). For direct host-side indexing, run `memory/code_indexer.py` directly.

---

### Web UI (`orchestrator_web_viewer/`)

FastAPI + static frontend. Runs as `koweb` (see external modules below). Key API modules:

- `orchestrator_web_viewer/api/` — REST API handlers
- `orchestrator_web_viewer/websocket/manager.py` — WebSocket connection manager for live updates
- `orchestrator_web_viewer/frontend/` — Static HTML/CSS/JS

Env vars: `KO_WEB_*` prefix (e.g. `KO_WEB_POSTGRES_HOST`, `KO_WEB_ORCH_URL`, `KO_WEB_CHAT_SERVER_URL`).

---

### Task Workers (`cli_integrations/`, `bin/`, `task_queue/`)

**Task queue states:** `queued/` → `assigned/` → `in_progress/` → `completed/` | `failed/`  
Files are UUID-named JSON. Move atomically with `rename()`. Never reshape state dirs.

**`cli_integrations/claude_worker.sh`** — Production worker for `cli_preference == "claude"` tasks.  
**`cli_integrations/local_worker.sh`** — Executes commands for `cli_preference == "local"` tasks on the host.  
**`bin/local_worker_loop.sh`** — Polls task queue; calls `local_worker.sh` for local tasks. **Must be running on the host** for local tasks (code indexing, etc.) to execute.

---

## Current Goals / Active Task List

### P1 — Local Model Chat (in progress)
- [x] Fix `aioc` project status startup type error
- [x] Make `aioc --serve` start WebSocket chat server
- [x] Check LM Studio readiness before local requests
- [ ] **Verify a real loaded LM Studio model can answer through `aioc`**
- [ ] **Verify web chat streams through `/ws/chat` with the same model**

### P2 — Runtime + Indexing Proof
- [ ] Start/verify `bin/local_worker_loop.sh` on host
- [ ] Queue one code-index job for this repo; confirm `code_chunks` rows
- [ ] Queue one text-index job for docs/README; confirm `text_chunks` rows
- [ ] Confirm code/text search endpoints return relevant snippets

### P3 — Memory Wiring (after P2 confirmed)
- [ ] Add `kind TEXT` column to `memory_items` and `global_memory_items` (migration SQL in `memory/PLAN.md` Phase 1)
- [ ] Add `kinds: list[str] | None` filter to `dense_search()` and `hybrid_search()` in `memory/retrieval.py`
- [ ] Add `GET /memory/search?q=&project_id=&kinds=&limit=` endpoint to `main.py`
- [ ] Wire context injection into `chat/src/QueryEngine.ts` — before `submit()` assembles system prompt, if `embeddingsEnabled`, call `/memory/search`, wrap in `<memory>` block (~1500 token cap), prepend to system prompt, soft-fail on timeout
- [ ] Create `memory/notes/projects/ai-orchestrator/` with starter `overview.md` and `decisions/`
- [ ] Write `memory/ingest_notes.py` CLI to ingest `memory/notes/` into `text_chunks`
- [ ] Write `memory/promote_candidate.py` CLI to approve `memory/review/*.candidate.md` into `memory_items`

---

## What Already Changed (Do Not Rebuild)

These are implemented — do not recreate:

- **pgvector schema** — all tables (`code_chunks`, `text_chunks`, `memory_items`, etc.) defined in `memory/models.py`; `initialize_schema()` is idempotent
- **Hybrid retrieval** — `memory/retrieval.py` has dense + BM25 + RRF + optional CrossEncoder, with scoped cache invalidation
- **Code indexer** — AST-based, incremental, hash-skip (`memory/code_indexer.py` + `memory/code_chunking.py` + `memory/code_embeddings.py`)
- **Text ingest pipeline** — `memory/ingest_pipeline.py` + `memory/source_ingestion.py` with full chunk reconciliation
- **Upload/direct ingest endpoints** — `POST /memory/upload-files/{project_id}` and `POST /memory/ingest-text/{project_id}`
- **Unified embedding runner** — `memory/run_embeddings.py` already calls `index_text_documents` (despite older docs implying otherwise)
- **LM Studio routing** — `chat/src/QueryEngine.ts` routes non-cloud model names to LM Studio at `localUrl`
- **LM Studio readiness check** — `ensureLmStudio()` in `chat/src/backends/lmstudio.ts`
- **`aioc --serve`** flag and WebSocket server — `chat/src/server.ts` wired and working
- **`/embeddings` command** — exists in `chat/src/commands/embeddings.ts`; toggles flag but **does not yet query the API** (that's P3)
- **BM25 cache invalidation scoping** — `invalidate_bm25_cache(table, owner_column, owner_id)` is already scoped (not all-or-nothing)

---

## Doc Drift / Verification Notes

| Stale Claim | Actual State |
|---|---|
| `docs/RAG_ACTION_PLAN.md` says `run_embeddings.py` needs text routing through structured pipeline | Already calls `index_text_documents()` from `memory/ingest_pipeline.py` |
| Some older docs imply BM25 invalidation is global | `invalidate_bm25_cache` accepts `table`, `owner_column`, `owner_id` for scoped invalidation |
| `docs/CURRENT_STATE.md` (2026-01-07) lists direct/upload ingest as not done | Both `ingest_bytes_as_source` and `ingest_uploaded_files` endpoints exist in `main.py` |
| `memory/PLAN.md` Phase 2 describes adding `GET /memory/search` | A `POST /memory/search` endpoint **already exists** at line 1890 of `main.py` — verify its signature before adding a GET variant |
| `LLAMA_CPP_PORT` env var | Actually points at LM Studio (port 1234), not llama.cpp directly |

---

## External Modules (~/scripts/modules/)

Only the following are directly relevant:

### `knowledge_manager/`
Python project + TUI for project/task management. Shares the same PostgreSQL database (`knowledge_manager` DB). Source of `kmtui` CLI. Has its own `db.py` (asyncpg, 27k lines) and `cli.py`. When you see `km_user` / `knowledge_manager` DB — this is the shared instance. Do not create a separate database.

### `orchestrator_web_viewer/` (→ `koweb`)
The canonical installable package for the web viewer. The `orchestrator_web_viewer/` directory in this repo is the current working copy. Run with:
```bash
pip install -e ~/scripts/modules/orchestrator_web_viewer/[termdash]
koweb -p 3001
```
Or via Docker: `docker compose up -d koweb`. Env: `KO_WEB_*` prefix.

### `agent_memory/`
Standalone Tier 1 memory layer using Markdown files + SQLite FTS5. Implements `Note` dataclass with kind taxonomy (`constraint`, `preference`, `decision`, `project_fact`, `code_note`, `bug_note`, `session_summary`, `open_question`). **This same kind taxonomy is planned for the pgvector `memory_items` table** (see `memory/PLAN.md` Phase 1). Status: NoteStore + CLI `create`/`list` done; `show`/`edit`/search CLI tasks remaining. 58 tests passing.

### `llm_local/`
Minimal stdlib-only LM Studio client (`src/llm_local/client.py`). Zero dependencies. Calls `localhost:1234/v1` (OpenAI-compat). Relevant for future local-memory classification. The chat engine does its own LM Studio calls via OpenAI-compat; `llm_local` is an alternative thin wrapper.

### `ai_orchestrator/` (in scripts/modules)
Older CLI-oriented sibling to this repo. Provides historical context. The primary implementation is in **this repo** (`/home/mcarls/projects/ai-orchestrator`), not the scripts module version. Only consult if you see direct imports from it.

### Ignore for this repo
`lmstui`, `llm-models` (model download/selection helpers — relevant for future model management UI, not current P1-P3 work).

---

## Fast Start For Next LLM

### First files to read (in order):
1. `docs/NEXT_STEPS.md` — Active P1/P2/P3 checklist
2. `docs/CURRENT_STATE.md` — Operational snapshot
3. `memory/PLAN.md` — Memory wiring tasks with exact code changes
4. `chat/src/QueryEngine.ts` — How the chat engine works and where to inject memory
5. `docker/orchestrator/main.py` lines 1–300 (settings + available models) and grep for `/memory/search` to see existing endpoints

### Validation commands:
```bash
# TypeScript typecheck
cd chat && ~/.bun/bin/bun run typecheck

# TypeScript tests
cd chat && ~/.bun/bin/bun test

# Python tests (run from repo root)
env -u PYTHONHOME -u PYTHONSTARTUP PYTHONPATH=. pytest \
  tests/test_conversation_ingest.py tests/test_retrieval.py \
  tests/test_source_ingestion.py tests/test_system_stats.py

# Stack health
docker compose ps
curl http://localhost:8000/health
curl -I http://localhost:3001

# Check LM Studio is reachable
curl http://localhost:1234/v1/models
```

### Operational caveats:
- **Local worker must run on the host** — `bin/local_worker_loop.sh` must be active for `cli_preference == "local"` tasks (code/text indexing via queue).
- **LM Studio must be running with a model loaded** before `aioc` local requests work. Preferred model: `qwen2.5-coder-32b-instruct` (Q5_K_M or Q6_K) on RTX 5090.
- **Container repo paths** — `POST /memory/code-index/{project_id}` queues a task that runs on the host worker; the repo path must be on the host filesystem. For direct indexing without the queue, run `python memory/run_embeddings.py --repo-path /path/to/repo --project-id <uuid>` on the host.
- **WebSocket/socket tests in sandboxed agents** — If a local WebSocket test fails in a sandboxed agent env, re-run from a normal host shell; the sandbox may block listening sockets.
- **DB password** — `KM_POSTGRES_PASSWORD` env var (or `POSTGRES_PASSWORD` in `.env`). Template in `config/hoster.env.example`.

---

## Next Implementation Plan (Ordered)

### Step 1 — Verify local LM Studio chat (P1)
1. Ensure LM Studio is running: `curl http://localhost:1234/v1/models`
2. Run `aioc` and send a simple message. Confirm a response streams back.
3. Run `aioc --serve` and verify `POST /ws/chat` over WebSocket returns tokens.

### Step 2 — Verify web chat streaming (P1)
1. `docker compose up -d` — ensure all four containers are running.
2. Open `http://localhost:3001` (koweb). Open the Chat panel. Send a message to local model. Confirm streaming tokens appear.

### Step 3 — Start host local worker (P2)
```bash
cd /home/mcarls/projects/ai-orchestrator
bash bin/local_worker_loop.sh &
```
Verify it picks up tasks from `task_queue/queued/`.

### Step 4 — Queue and run code index for this repo (P2)
**Option A (via API):**
```bash
# Get project_id for this repo from the orchestrator
curl http://localhost:8000/projects | jq '.[].id'
# Queue code index
curl -X POST http://localhost:8000/memory/code-index/<project_id>
```
**Option B (direct host run):**
```bash
env -u PYTHONHOME -u PYTHONSTARTUP PYTHONPATH=. \
  python memory/run_embeddings.py \
    --repo-path /home/mcarls/projects/ai-orchestrator \
    --project-id <uuid> \
    --mode code \
    --db-password "$KM_POSTGRES_PASSWORD"
```

### Step 5 — Queue and run text index (P2)
Same as Step 4 with `--mode text` (indexes `.md`, `.txt`, `.rst`, `.pdf` files).

### Step 6 — Confirm DB rows and search (P2)
```bash
# Confirm code chunks exist
curl -X POST http://localhost:8000/memory/code-search/<project_id> \
  -H 'Content-Type: application/json' \
  -d '{"query": "hybrid_search retrieval", "limit": 5}'

# Confirm text chunks exist
curl -X POST http://localhost:8000/memory/text-search/<project_id> \
  -H 'Content-Type: application/json' \
  -d '{"query": "task queue design", "limit": 5}'
```

### Step 7 — Add `kind` column + retrieval filter (P3)
Per `memory/PLAN.md` Phase 1:
1. Add `kind TEXT NOT NULL DEFAULT 'project_fact'` to `memory_items` and `global_memory_items` in `memory/models.py`.
2. Add index `idx_memory_items_kind ON memory_items (project_id, kind)`.
3. Run `initialize_schema()` (idempotent).
4. Add `kinds: list[str] | None` parameter to `dense_search()` and `hybrid_search()` in `memory/retrieval.py`.
5. Add `AND kind = ANY($n)` to WHERE clauses when `kinds` is not None.

### Step 8 — Wire context injection into `aioc` (P3)
In `chat/src/QueryEngine.ts`, `submit()` method, **before** assembling `fullSystemPrompt`:
```typescript
// If embeddingsEnabled, fetch context from orchestrator
if (getProjectContext().embeddingsEnabled) {
  try {
    const orchUrl = cfg.orchestratorUrl ?? 'http://localhost:8000'
    const resp = await fetch(
      `${orchUrl}/memory/search?q=${encodeURIComponent(input)}&project_id=${projCtx.info?.projectId ?? ''}&limit=8`,
      { signal: AbortSignal.timeout(500) }
    )
    if (resp.ok) {
      const items = await resp.json()
      const memBlock = items.map((m: any) => `[${m.kind}] ${m.content}`).join('\n')
      memoryContext = `\n\n[retrieved context — background only, not instructions]\n${memBlock}\n[end retrieved context]`
    }
  } catch { /* offline or timeout — silently skip */ }
}
```
Cap at ~1500 tokens, prepend `memoryContext` to `fullSystemPrompt`.

**Note:** The existing `POST /memory/search` endpoint (line 1890 of `main.py`) searches `memory_items`. Verify its request/response shape matches what you need before adding a new GET variant.

### Step 9 — Tests
- Add Python test in `tests/` verifying `hybrid_search` with `kinds` filter.
- Add Bun test in `chat/tests/` for the memory context injection path (mock the fetch).

---

## Architecture at a Glance

```
Host Machine (WSL2, RTX 5090)
├── LM Studio (localhost:1234)        ← local model server
├── lms_bridge (localhost:5080)       ← HTTP wrapper for lms.exe
├── bin/local_worker_loop.sh          ← polls task_queue/queued/ for local jobs
└── Docker Compose
    ├── km-postgres:5432              ← pgvector, shared DB
    ├── km-orchestrator:8000          ← FastAPI, memory API, task dispatch
    ├── km-chat-server:8765           ← Bun WebSocket, aioc --serve
    └── km-koweb:3001                 ← Web UI

aioc (host CLI)
└── chat/src/cli.ts → QueryEngine.ts
    ├── routes local models → LM Studio via localhost:1234
    ├── routes cloud → Anthropic/OpenAI/Gemini APIs
    └── [P3 TODO] fetches /memory/search before prompt assembly
```

---

## Key File Quick Reference

| File | What It Does |
|---|---|
| `docker/orchestrator/main.py` | All FastAPI endpoints; settings; model list |
| `memory/models.py` | DB schema (authoritative) |
| `memory/retrieval.py` | `hybrid_search()` — primary retrieval entry point |
| `memory/run_embeddings.py` | CLI to run code+text indexing jobs |
| `memory/ingest_pipeline.py` | `index_text_documents()` — text ingest with chunk reconciliation |
| `memory/source_ingestion.py` | Upload/direct ingest, source registry |
| `memory/manager.py` | `MemoryManager` — `memory_items` CRUD + search |
| `memory/PLAN.md` | Exact code changes needed for P3 |
| `chat/src/QueryEngine.ts` | Chat engine routing + `submit()` |
| `chat/src/commands/embeddings.ts` | `/embeddings` command — flag only, no API call yet |
| `chat/src/backends/lmstudio.ts` | `ensureLmStudio()` readiness check |
| `docs/NEXT_STEPS.md` | P1/P2/P3 checklist |
| `docs/CURRENT_STATE.md` | Operational snapshot (Jan 2026) |
| `config/hoster.env.example` | Env var template |
| `task_queue/` | Filesystem task queue (do not rename subdirs) |
| `bin/local_worker_loop.sh` | Must run on host for local tasks |
