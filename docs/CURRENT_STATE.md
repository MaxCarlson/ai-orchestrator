# Current State

**Date**: 2026-01-07  
**Location**: WSL2 hoster (Windows 11 + WSL2)  
**Primary Goal**: Use RTX 5090 to index code and feed code context into tasks

---

## Historical Snapshot (2026-01-07)

> This is a point-in-time snapshot, not the current operational state. Its process, model, and indexing claims must be rechecked. See [`docs/plans/20260926_ai-assistant/00_implementation-plan.md`](plans/20260926_ai-assistant/00_implementation-plan.md) and its feature audit before relying on the status. Live host checks are not established by this historical document.

### Working
- PostgreSQL in Docker (shared with knowledge_manager).
- Orchestrator API container (FastAPI) running on port 8000.
- Filesystem task queue (`task_queue/`) with real Claude worker.
- Orchestrator Web Viewer module exists in `orchestrator_web_viewer/`.

### Newly Added (Code-Aware Indexing)
- `memory/code_chunking.py`: AST-based Python symbol chunker.
- `memory/code_embeddings.py`: CodeBERT embedder (768-dim).
- `memory/code_indexer.py`: Incremental indexer (hash-based skip).
- `memory/code_search.py`: Vector-only search on `code_chunks`.
- `cli_integrations/local_worker.sh`: Runs host-side commands from task context.
- `config/hoster.env.example`: Shared env template for KM/KMTUI/KOWEB.
- `docs/NEXT_STEPS.md`: Short active task list.

### Not Done Yet
- No repository has been vectorized in practice.
- Code index job has not been run on RTX 5090 yet.
- KM/KMTUI/KOWEB env config not fully standardized.

---

## How To Run First Code Index (Host)

1. Copy and fill in the hoster env file:
   - `config/hoster.env.example` -> `config/hoster.env`
   - Export `KM_POSTGRES_PASSWORD`
2. Run (from repo root):
   ```bash
   python memory/code_indexer.py --repo-path /path/to/repo \
     --project-id <uuid> --db-host localhost --db-port 5432 \
     --db-name knowledge_manager --db-user km_user \
     --db-password "$KM_POSTGRES_PASSWORD"
   ```
3. Verify search with:
   - `POST /memory/code-search/{project_id}` (query text)

**Note:** The `/memory/code-index/{project_id}` endpoint queues a `local` worker
task. It will only work if the repo path is mounted into the orchestrator
container; otherwise run the command directly on the host.

---

## Next Steps (Short List)

Use `docs/NEXT_STEPS.md` for active short-horizon execution tasks.
