# Memory Subsystem Integration Plan

This document defines **exactly what must be implemented** to fully wire the
Hierarchical Memory System into the AI Orchestrator.

This file is written to be handed directly to another LLM agent.

---

## Phase 0 — Preconditions

- PostgreSQL is running
- SQLite → PostgreSQL migration complete
- pgvector extension available
- Task queue exists
- Orchestrator service exists

---

## Phase 1 — Database Initialization

Tasks:
- Enable required extensions:
  - vector
  - pgcrypto
- Run schema initialization using memory.manager.initialize_schema
- Ensure indexes are created

Outcome:
- Memory tables exist
- Vector search is operational

---

## Phase 2 — Task Queue Integration (Critical)

Add task types:
- index_repo
- reindex_repo
- delete_project_memory

Each task must include:
- project_id
- repo_path
- scope (code | text | both)
- optional limits (file caps, chunk sizes)

Execution model:
- Asynchronous
- GPU-heavy jobs must not block orchestrator
- One embedding job per GPU initially

---

## Phase 3 — Orchestrator API Wiring

Add API endpoints:
- POST /memory/index-repo
- POST /memory/reindex-repo
- GET /memory/search
- POST /memory/feedback

Endpoints must:
- Validate permissions
- Enqueue tasks
- Return job IDs
- Allow progress tracking

---

## Phase 4 — LLM and CLI Memory Access

Enable direct access for:
- Claude Code
- Codex CLI
- Gemini CLI
- Custom tools

Capabilities:
- Semantic search with filters
- Project-scoped retrieval
- Category-scoped retrieval

Orchestrator may:
- Inject memory into prompts
- Annotate responses with memory provenance
- Track which memories influenced output

---

## Phase 5 — Automatic Memory Creation

Orchestrator agent responsibilities:
- Observe CLI output
- Observe long-running tasks
- Detect important artifacts:
  - Design documents
  - Decisions
  - Repeated failures
  - Fixes and resolutions
- Propose memory creation

User interaction:
- User must be notified when memory is created
- User can approve, delete, or mark as bad
- Feedback updates retention score

---

## Phase 6 — Retention and Eviction

Signals per memory:
- Access count
- Last accessed timestamp
- Creation timestamp
- User feedback score
- Project and category quota pressure

Eviction policy:
- Remove lowest-scoring memories first
- Prefer evicting old, unused, negatively rated memories
- Pinned memories are never evicted

---

## Phase 7 — Embedding Model Registry (Future)

Optional enhancements:
- Track embedding model per memory
- Support re-embedding when models change
- Separate models for:
  - Code
  - Prose
  - Logs
  - Structured data

---

## Phase 8 — UX Improvements (Lower Priority)

- TUI memory browser
- Per-project memory dashboards
- Memory diffs
- “Why was this memory used?” explanations

---

## Definition of Done (MVP)

- User creates project in kmtui
- User requests repository indexing
- RTX 5090 generates embeddings
- Memories stored in PostgreSQL
- LLMs retrieve relevant memory
- User can give feedback
- Memory persists across sessions

---

## Guiding Principle

Memory should behave like a trusted collaborator:
helpful, selective, and correct — never noisy.

