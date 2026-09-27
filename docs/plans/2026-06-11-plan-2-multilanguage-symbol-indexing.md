# Plan 2: Multi-Language Symbol Indexing

**Created:** 2026-06-11
**Status:** Planned
**Primary source:** `docs/research/AI-Orchestrator-Deep-Research-Architecture-Recommendations.md`

## Purpose

Expand code indexing beyond Python-only AST chunks so the orchestrator can
retrieve important TypeScript, TSX, shell, and configuration surfaces in this
repo. This addresses the research document's coverage-mismatch finding without
starting a separate graph database or a full indexing rewrite.

## Depends On

- `docs/research/AI-Orchestrator-Deep-Research-Architecture-Recommendations.md`
  - Top decision 3
  - Concrete backlog items 3 and 4
- `docs/handoffs/AI-ORCHESTRATOR-HANDOFF.md`
  - Repo map listing `chat/src/QueryEngine.ts`, `chat/src/commands/embeddings.ts`,
    and `bin/local_worker_loop.sh` as core surfaces
- `memory/README.md`
  - Current `memory/code_chunking.py` and `memory/code_indexer.py` responsibilities
- Plan 1
  - Eval fixtures should identify whether new language coverage improves
    retrieval.

## Scope

1. Add cheap language detection and symbol metadata fields.
2. Add TypeScript/TSX symbol extraction for common declarations and exports.
3. Add shell symbol extraction for functions and script-level chunks.
4. Add config/documentation fallback chunks for files that are code-adjacent but
   not AST parsed.
5. Add fixture tests using representative files from this repo.

## Tasks

## Task Log

**Context:** This plan implements the research document's coverage-mismatch
recommendation: code retrieval must cover TypeScript and shell surfaces, not
only Python AST chunks.

**Decisions:**

- Start with deterministic parser adapters and shebang detection instead of
  adding Tree-sitter immediately.
- Add structural metadata to the in-memory `CodeChunk` shape first; defer DB
  persistence until the smallest compatible schema is clear.

**Notes/Risks:**

- TypeScript and shell parsing is intentionally conservative and should be
  evaluated against real repo queries before expanding.
- Live indexing with embeddings/DB remains pending because the local DB/API was
  not reachable in the current sandbox.

**Testing:**

- `python -m py_compile memory/code_chunking.py memory/code_indexer.py tests/test_code_chunking_multilanguage.py` (pass)
- `pytest tests/test_code_chunking_multilanguage.py tests/test_code_search.py tests/test_retrieval_eval.py tests/test_retrieval.py -q` (10 passed)
- `ruff check memory/code_chunking.py memory/code_indexer.py memory/code_search.py eval/retrieval/run_eval.py tests/test_code_chunking_multilanguage.py tests/test_code_search.py tests/test_retrieval_eval.py` (pass)
- `pytest tests/test_code_chunking_multilanguage.py tests/test_code_search.py tests/test_retrieval_eval.py tests/test_retrieval.py tests/test_task_queue_controls.py tests/test_orch_cli.py tests/test_source_ingestion.py -q` (24 passed, 7 pre-existing `datetime.utcnow()` deprecation warnings)
- `docker compose up -d --build orchestrator` with escalation (pass; rebuilt
  image includes current chunking/indexer code)

### 1. Code Chunk Metadata Extensions

- [x] Implemented
- [x] Verified working — `pytest tests/test_code_chunking_multilanguage.py -q`

Extend chunk metadata in Python code to carry cheap structural fields where
available: `module`, `symbol_kind`, `qualified_name`, `parent_symbol`,
`is_test`, and `imports`/`exports` hints. Persist fields in PostgreSQL only
after deciding the smallest compatible schema change.

Verification method:

- Unit test chunk objects for Python, TypeScript, and shell fixtures.
- Schema migration smoke test if new persisted columns are added.

Notes:

- Avoid hard-to-reverse schema churn. JSONB metadata is acceptable if that best
  matches the current code.
- Added non-persisted `module`, `symbol_kind`, `qualified_name`,
  `parent_symbol`, and `is_test` fields to `CodeChunk`.

### 2. TypeScript And TSX Chunking

- [x] Implemented
- [x] Verified working — `pytest tests/test_code_chunking_multilanguage.py -q`

Add symbol-aware chunking for `.ts` and `.tsx` files. The first version can use
conservative parsing heuristics if adding Tree-sitter is too large for this
pass, but the plan should leave a clean adapter boundary for Tree-sitter.

Verification method:

- Fixture tests using `chat/src/QueryEngine.ts` and
  `chat/src/commands/embeddings.ts`.

Notes:

- Target common declarations first: exported functions, classes, interfaces,
  type aliases, const command handlers, and module-level fallback chunks.
- Added conservative extraction for `.ts` and `.tsx` declarations.

### 3. Shell Script Chunking

- [x] Implemented
- [x] Verified working — `pytest tests/test_code_chunking_multilanguage.py -q`

Add chunking for `.sh`, extensionless executable scripts where appropriate, and
repo `bin/` scripts. Extract shell functions and maintain a script-level
fallback chunk.

Verification method:

- Fixture tests using `bin/local_worker_loop.sh` and `bin/orch`.

Notes:

- Preserve deterministic behavior and avoid executing shell files.
- Added extraction for shell function forms plus script-level fallback chunks.
- Added shebang detection for extensionless Python and shell scripts.

### 4. Indexer Integration

- [x] Implemented
- [ ] Verified working

Wire the new chunkers into `memory/code_indexer.py` without breaking hash-skip
semantics. Ensure unchanged chunks still skip re-embedding and changed chunks
upsert correctly.

Verification method:

- Unit tests for changed/unchanged chunk hash behavior where practical.
- Manual indexing smoke test after Plan 1 live proof is available.
- Current verification: compile and chunker tests passed, and the rebuilt
  orchestrator image includes current code. Live embedding/indexing smoke is
  still pending.

### 5. Minimal Repo Graph Prep

- [x] Implemented
- [x] Verified working — documented in this plan; no code/schema change

Document and optionally add the smallest relational sidecar shape for future
`repo_symbols` and `repo_edges` tables. Do not implement graph expansion until
the eval harness can compare it.

Verification method:

- Plan/doc review only unless schema is added.

Proposed future sidecar:

`repo_symbols`

- `id BIGSERIAL PRIMARY KEY`
- `project_id UUID NOT NULL`
- `file_path TEXT NOT NULL`
- `language TEXT NOT NULL`
- `symbol_name TEXT NOT NULL`
- `qualified_name TEXT NOT NULL`
- `symbol_kind TEXT NOT NULL`
- `start_line INTEGER NOT NULL`
- `end_line INTEGER NOT NULL`
- `metadata JSONB NOT NULL DEFAULT '{}'::jsonb`
- unique key: `(project_id, file_path, qualified_name)`

`repo_edges`

- `id BIGSERIAL PRIMARY KEY`
- `project_id UUID NOT NULL`
- `source_symbol_id BIGINT NULL`
- `target_symbol_id BIGINT NULL`
- `source_path TEXT NOT NULL`
- `target_path TEXT NOT NULL`
- `edge_kind TEXT NOT NULL`
- `confidence DOUBLE PRECISION NOT NULL DEFAULT 1.0`
- `metadata JSONB NOT NULL DEFAULT '{}'::jsonb`

Initial `edge_kind` values:

- `defines`
- `imports`
- `calls`
- `tests`
- `documents`

Use this only for post-retrieval expansion after Plan 1 evals can compare
`code_hybrid` against `graph_hybrid`.

## Out Of Scope

- Full graph expansion at query time.
- External graph database.
- Embedding model changes.
- Web UI changes.

## Completion Criteria

- Code indexing covers Python, TypeScript/TSX, and shell surfaces.
- Fixture tests prove representative symbols are extracted.
- Existing Python indexing behavior still works.
- Any schema changes are idempotent and documented.
