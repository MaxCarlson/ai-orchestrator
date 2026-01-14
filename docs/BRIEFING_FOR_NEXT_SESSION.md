# Briefing for Next Session

**Date**: 2026-01-07  
**Location**: WSL2 hoster (Windows 11 + WSL2)  
**Primary Goal**: Use RTX 5090 to index code and feed code context into tasks

---

## Current State (Trust This Over Older Docs)

This repo has moved beyond initial setup. Some older markdown still reflects earlier phases.
Use this briefing + `docs/NEXT_STEPS.md` as the active source of truth.

### Working
- PostgreSQL in Docker (shared with knowledge_manager).
- Orchestrator API container (FastAPI) running on port 8000.
- Filesystem task queue (`task_queue/`) with real Claude worker.
- Orchestrator Web Viewer exists in `~/scripts/modules/orchestrator_web_viewer`.

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

See `docs/NEXT_STEPS.md`. Keep it updated and short.
