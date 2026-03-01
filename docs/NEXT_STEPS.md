# AI Orchestrator - Short-Term Task List

This file tracks a small, actively-managed set of tasks. It is derived from the
broader plans in `ai-orchestrator-briefing.md`, `GOALS.md`, and `memory/*`.
Keep this list short, update status as work progresses, and check items off when done.

## Active Priorities

### P1 - GPU Code Indexing (RTX 5090)
- [x] Define code-aware indexing schema (code_chunks + indexes).
- [x] Implement Python AST chunker (symbol-level) with safe fallbacks.
- [x] Add code embedding adapter (CodeBERT 768-dim) with GPU/CPU fallback.
- [x] Build incremental indexer (hash-based skip, project_id scope).
- [x] Add retrieval API (vector-only).
- [x] Wire orchestrator pre-dispatch context injection using code search.
- [ ] Run first GPU indexing job against a tracked repo.
- [ ] Validate code-search results in queued task payloads.

### P2 - KM/KMTUI Host DB Consistency
- [ ] Standardize env config for KM/KMTUI/KOWEB to point to WSL2 host DB.
- [ ] Validate KM actions in CLI + Web UI still hit the hoster database.

## Notes

- The long-form historical plan for code-aware indexing is archived at
  `docs/archive/memory_advanced-code-embedding-implementation-plan.md`.
- When the list grows, split into multiple short lists and link them here.
