# Plan 3: Durable Memory Wiring And Review Flow

**Created:** 2026-06-11
**Status:** Planned
**Primary source:** `docs/research/AI-Orchestrator-Deep-Research-Architecture-Recommendations.md`

## Purpose

Implement the next durable-memory layer in a way that keeps generated memories
reviewable and keeps retrieved context labeled as data, not instructions. This
plan follows the existing `memory/PLAN.md` phases but updates the sequencing
based on the research recommendation to layer rebuildable indexes, human notes,
review candidates, and approved durable memory.

## Depends On

- `docs/research/AI-Orchestrator-Deep-Research-Architecture-Recommendations.md`
  - Memory architecture recommendation
  - Concrete backlog item 8
- `memory/PLAN.md`
  - Phases 1, 2, and 3
- `docs/NEXT_STEPS.md`
  - P3 Memory Wiring
- `docs/handoffs/AI-ORCHESTRATOR-HANDOFF.md`
  - Current `/embeddings` command gap and chat context-injection notes
- Current source:
  - `memory/models.py`
  - `memory/manager.py`
  - `memory/retrieval.py`
  - `docker/orchestrator/main.py`
  - `chat/src/QueryEngine.ts`
  - `chat/src/commands/embeddings.ts`

## Scope

1. Add a closed memory kind taxonomy.
2. Add kind storage and filtering for durable memories.
3. Add a read-only memory search endpoint suitable for chat-time context.
4. Add human-editable notes directory conventions.
5. Add generated candidate review conventions before any promotion to
   `memory_items`.
6. Wire chat context injection only after the API and tests prove stable.

## Tasks

## Task Log

**Context:** This plan wires durable approved memory separately from rebuildable
code/text indexes, following the research document and `memory/PLAN.md`.

**Decisions:**

- Add `kind` as a Python-validated text field, not a Postgres enum.
- Apply `kinds` filtering only to durable `memory_items`, not to rebuildable
  `code_chunks` or `text_chunks`.

**Notes/Risks:**

- Live schema migration smoke passed against localhost Postgres. API route
  smoke and DB-backed note ingestion/promotion remain pending because follow-up
  localhost/Docker checks were blocked by approval-review usage limits.
- `docker/orchestrator/main.py` has pre-existing ruff issues; focused lint was
  run on the new/touched memory modules and tests.

**Testing:**

- `python -m py_compile memory/kinds.py memory/models.py memory/manager.py docker/orchestrator/main.py tests/test_memory_kinds.py` (pass)
- `ruff check memory/kinds.py memory/manager.py memory/code_chunking.py memory/code_indexer.py memory/code_search.py eval/retrieval/run_eval.py tests/test_memory_kinds.py tests/test_code_chunking_multilanguage.py tests/test_code_search.py tests/test_retrieval_eval.py` (pass)
- `pytest tests/test_memory_kinds.py tests/test_code_chunking_multilanguage.py tests/test_code_search.py tests/test_retrieval_eval.py tests/test_retrieval.py tests/test_task_queue_controls.py tests/test_orch_cli.py tests/test_source_ingestion.py -q` (28 passed, 7 pre-existing `datetime.utcnow()` deprecation warnings)
- `python -m py_compile memory/ingest_notes.py memory/promote_candidate.py tests/test_memory_notes_cli.py` (pass)
- `pytest tests/test_memory_notes_cli.py tests/test_memory_kinds.py -q` (7 passed)
- `python -m memory.ingest_notes -p ba8f2b31-e5d6-4a5e-bf40-d51c016a495e -d memory/notes/projects/ai-orchestrator -k project_fact -n` (dry-run pass)
- `python -m memory.promote_candidate -f memory/notes/projects/ai-orchestrator/overview.md -k project_fact -p ba8f2b31-e5d6-4a5e-bf40-d51c016a495e -n` (dry-run pass)
- Host `initialize_schema()` smoke against localhost Postgres verified
  `memory_items.kind`, `global_memory_items.kind`, and kind indexes.

### 1. Memory Kind Schema And Validation

- [x] Implemented
- [x] Verified working — `pytest tests/test_memory_kinds.py -q` via broader
  targeted run; py_compile passed

Add `kind` to `memory_items` and `global_memory_items`, define the closed
Python taxonomy from `memory/PLAN.md`, and validate writes in `MemoryManager`
and API inputs.

Verification method:

- Schema initialization test.
- Unit test for valid/invalid kinds.

Notes:

- Default kind remains `project_fact`.
- Enforce in Python first, not a DB enum.
- Added `memory/kinds.py`, schema columns/indexes, API validation, and
  `MemoryManager.add_memory(kind=...)`.
- Live schema smoke verified `memory_items.kind`, `global_memory_items.kind`,
  `idx_memory_items_kind`, and `idx_global_memory_items_kind`.

### 2. Kinds Filter In Retrieval

- [x] Implemented
- [x] Verified working — `pytest tests/test_memory_kinds.py -q` via broader
  targeted run

Add a `kinds` filter to durable-memory search paths. Do not apply this to
`code_chunks` or `text_chunks`; those are rebuildable indexes, not approved
durable memories.

Verification method:

- Python retrieval test proving selected kinds are included/excluded.

### 3. Chat-Safe Memory Search API

- [x] Implemented
- [ ] Verified working

Expose a chat-safe read endpoint, preserving the existing `POST /memory/search`
behavior unless there is a deliberate documented change. Add a GET convenience
route only if it does not conflict with existing clients.

Verification method:

- API test or FastAPI route smoke test.

Notes:

- Response items should include `kind`, `content`, `source`/provenance where
  available, and score.
- Preserved existing `POST /memory/search`; no GET route added yet.
- Memory list/search responses now include `kind`.
- Py_compile passed, but FastAPI route smoke is still pending because the app
  runtime was not available in this sandbox.

### 4. Notes Directory And Ingest CLI

- [x] Implemented
- [ ] Verified working

Create the `memory/notes/` convention and add `memory/ingest_notes.py` to ingest
Markdown notes through existing source-ingestion/text-chunk paths.

Verification method:

- CLI dry-run test.
- Ingestion smoke test if DB is available.

Notes:

- Human-authored notes are editable source material.
- Generated content must not write straight to durable memory.
- Added `memory/notes/projects/ai-orchestrator/overview.md`,
  `open-questions.md`, `decisions/.gitkeep`, and `memory/ingest_notes.py`.
- Dry-run CLI and parser tests pass; real DB-backed note ingestion remains
  pending.

### 5. Review Candidate Promotion CLI

- [x] Implemented
- [ ] Verified working

Create `memory/review/` convention and `memory/promote_candidate.py` so
generated candidate Markdown can be reviewed and explicitly promoted into
`memory_items`.

Verification method:

- Unit test candidate parsing.
- Dry-run or mocked promotion test.

Notes:

- Added `memory/review/.gitkeep` and `memory/promote_candidate.py`.
- Candidate parser tests and dry-run promotion pass.
- Real promotion remains pending because it loads an embedding model and writes
  to Postgres after explicit review.

### 6. `aioc` Context Injection

- [ ] Implemented
- [ ] Verified working

When embeddings are enabled for the chat project, fetch memory context before a
message, wrap it in a clearly labeled block, cap size, and soft-fail if the
orchestrator is unreachable.

Verification method:

- Bun unit test with mocked fetch.
- Manual `aioc` smoke test when LM Studio and orchestrator are available.

Notes:

- Retrieved context is background data, not instruction text.
- This should not block offline/local chat.

## Out Of Scope

- Automatic session summaries.
- Memory eviction/retention jobs.
- MCP adapter.
- Deep merge of `~/scripts/modules/agent_memory`.
- Web UI changes.

## Completion Criteria

- Durable memories have kind taxonomy and filtering.
- Notes and review candidates have concrete CLI workflows.
- Chat can inject approved memory context without breaking offline operation.
- Tests or smoke checks are recorded next to each verified item.
