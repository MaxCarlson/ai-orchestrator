# Plan 1: Retrieval Proof And Code Hybrid Search

**Created:** 2026-06-11
**Status:** Active
**Primary source:** `docs/research/AI-Orchestrator-Deep-Research-Architecture-Recommendations.md`

## Purpose

Implement the first research recommendations without changing the platform shape:
prove retrieval behavior, add a measurable local evaluation harness, and remove
the code-search asymmetry by making `code_chunks` searchable with lexical +
dense fusion.

This plan intentionally keeps the current FastAPI + PostgreSQL/pgvector +
filesystem-worker architecture. It does not swap embedding models, introduce an
external vector database, or rewrite the queue.

## Depends On

- `docs/research/AI-Orchestrator-Deep-Research-Architecture-Recommendations.md`
  - Executive recommendations 1, 2, and 3
  - Concrete backlog items 1, 2, and 5
- `docs/handoffs/AI-ORCHESTRATOR-HANDOFF-2.md`
  - Project registration, `.kmproj`, and first indexing proof notes
- `docs/handoffs/AI-ORCHESTRATOR-HANDOFF.md`
  - Trust order, memory/retrieval module map, and P2/P3 gaps
- `docs/NEXT_STEPS.md`
  - P2 Runtime + Indexing Proof
- `memory/PLAN.md`
  - Definition of done requires one GPU indexing job and 5+ representative
    retrieval queries
- Current source:
  - `memory/models.py`
  - `memory/retrieval.py`
  - `memory/code_search.py`
  - `memory/run_embeddings.py`
  - `docker/orchestrator/main.py`
- `LLM-README.md`
  - Running task log, small verifiable steps, and testing expectations.

## Scope

1. Add a small retrieval evaluation fixture set for this repo.
2. Add a local eval runner that can score expected file/symbol anchors without
   requiring external APIs.
3. Add PostgreSQL full-text search support for `code_chunks` and
   `global_code_chunks`.
4. Make code search hybrid by fusing dense code search with lexical code search.
5. Preserve the existing `POST /memory/code-search/{project_id}` API shape.
6. Add focused tests that prove fusion/ranking behavior at the Python level.

## Tasks

## Task Log

**Context:** This plan implements the research document's near-term retrieval
recommendations while preserving the existing architecture.

**Decisions:**

- Use a local eval fixture/runner before model changes.
- Use PostgreSQL FTS plus existing dense code vectors rather than adding a new
  search service.
- Keep the existing code-search API response compatible.

**Notes/Risks:**

- Live DB/indexing verification may require Docker/Postgres and local embedding
  dependencies that are not available in every agent sandbox.
- The first automated tests should avoid requiring model downloads.

**Testing:**

- `python -m py_compile memory/models.py memory/manager.py memory/code_search.py docker/orchestrator/main.py eval/retrieval/run_eval.py tests/test_code_search.py tests/test_retrieval_eval.py` (pass)
- `pytest tests/test_code_search.py tests/test_retrieval_eval.py tests/test_retrieval.py -q` (7 passed)
- `pytest tests/test_code_search.py tests/test_retrieval_eval.py tests/test_retrieval.py tests/test_task_queue_controls.py tests/test_orch_cli.py tests/test_source_ingestion.py -q` (21 passed, 7 pre-existing `datetime.utcnow()` deprecation warnings)
- `python eval/retrieval/run_eval.py --results /tmp/aiorch-retrieval-results.json --k 1 3` (pass with temporary JSON results)
- Host `initialize_schema()` smoke against localhost Postgres with escalation
  (pass; verified code `search_vector` columns and indexes)
- `docker compose up -d --build orchestrator` with escalation (pass; image
  built and `km-orchestrator` started)

### 1. Retrieval Evaluation Fixtures

- [x] Implemented
- [x] Verified working — `pytest tests/test_retrieval_eval.py -q` via targeted run;
  `python eval/retrieval/run_eval.py --results /tmp/aiorch-retrieval-results.json --k 1 3`

Create `eval/retrieval/queries.yaml`, `eval/retrieval/qrels.tsv`, and
`eval/retrieval/run_config.yaml` with the seed query domains recommended in the
research document: task queue, project registration, embedding pipeline,
retrieval/memory, LM Studio/routing, and controls.

Verification method:

- Run the eval loader test or CLI dry run and record the command here.

Notes:

- Keep fixtures small enough for fast local iteration.
- Expected anchors should include path and optional symbol names.
- Added `eval/retrieval/queries.yaml`, `eval/retrieval/qrels.tsv`, and
  `eval/retrieval/run_config.yaml`.

### 2. Retrieval Eval Runner

- [x] Implemented
- [x] Verified working — `pytest tests/test_retrieval_eval.py -q` via targeted run;
  CLI smoke with temporary results JSON passed

Add a stdlib-friendly runner, likely `eval/retrieval/run_eval.py`, that loads
queries/qrels and computes at least Recall@k and MRR@k from returned result
paths/symbols. The first version may support a fixture/mock result provider for
unit tests and a live API mode for manual validation.

Verification method:

- Run unit tests for metric calculations.
- Run the runner in dry/mock mode.

Notes:

- Do not require a running embedding model for the unit-test path.
- Live mode can remain manual until the database/indexing stack is available.
- Added `eval/retrieval/run_eval.py` with Recall@k and MRR@k scoring.

### 3. PostgreSQL FTS Columns And Indexes For Code Chunks

- [x] Implemented
- [x] Verified working — host `initialize_schema()` smoke against running
  Postgres verified `search_vector` columns and GIN indexes

Extend `memory/models.py` schema initialization with generated or maintained
`tsvector` search support for `code_chunks` and `global_code_chunks`, plus GIN
indexes. Include idempotent migration SQL for existing databases.

Verification method:

- Run `initialize_schema()` in a test or smoke path.
- If DB is available, verify indexes/columns exist with a SQL query.

Notes:

- Prefer Postgres-native FTS first, per the research recommendation.
- Keep vector dimensions unchanged.
- Added generated `search_vector` SQL and GIN index SQL for `code_chunks` and
  `global_code_chunks`.
- Automated tests verify the schema SQL is present.
- Live DB verification initially failed in the sandbox, then passed with
  escalated localhost Postgres access. The schema smoke verified
  `code_chunks.search_vector`, `global_code_chunks.search_vector`,
  `idx_code_chunks_search_vector`, and `idx_global_code_chunks_search_vector`.
- Rebuilt/restarted `km-orchestrator` with `docker compose up -d --build
  orchestrator`; follow-up API health smoke was blocked by approval-review usage
  limits, not by a reported container failure.

### 4. Hybrid Code Search Implementation

- [x] Implemented
- [x] Verified working — `pytest tests/test_code_search.py tests/test_retrieval.py -q`
  via targeted run

Replace `memory/code_search.py` vector-only behavior with dense + lexical code
retrieval and RRF-style fusion. Returned rows must remain compatible with the
existing API response fields: `file_path`, `symbol_name`, `chunk_type`,
`start_line`, `end_line`, `content`, and `similarity`. Add lexical/fusion scores
as extra fields if useful.

Verification method:

- Unit tests against fake rows or a temporary DB.
- Manual `/memory/code-search/{project_id}` smoke test when the stack is
  available.

Notes:

- Code search should favor exact identifiers, route names, CLI flags, and file
  names that dense retrieval can miss.
- Keep the endpoint shape stable.
- `memory/code_search.py` now runs dense code search plus PostgreSQL FTS and
  fuses candidates with RRF.

### 5. API Wiring And Documentation Updates

- [x] Implemented
- [x] Verified working — `python -m py_compile ...` and targeted pytest run

Update `docker/orchestrator/main.py` only as needed so the code search endpoint
uses the new hybrid implementation. Update `memory/README.md` and
`docs/NEXT_STEPS.md` to reflect code hybrid search and the eval harness.

Verification method:

- Compile/import checks for touched Python files.
- Focused tests for API helper behavior where practical.

Notes:

- Do not claim end-to-end indexing is verified unless a real indexing/search
  smoke test has passed.
- Updated the FastAPI code-search endpoint and task code-context helper to pass
  the original query text into hybrid code search.
- Updated `memory/README.md` and `docs/NEXT_STEPS.md`.
- End-to-end indexing/search remains unverified because no live DB/indexing
  smoke was run in this slice.

## Out Of Scope

- Switching CodeBERT/BGE to another embedding model.
- Adding Tree-sitter or multi-language parsing. That is Plan 2.
- Adding repo graph tables. That follows Plan 2/eval evidence.
- Web UI changes.

## Completion Criteria

- The eval fixture set and runner exist.
- Code chunks have a Postgres lexical search path.
- Existing code search API uses hybrid code retrieval internally.
- Focused automated tests pass.
- Any live/manual validation is recorded in this plan before checking
  `Verified working`.
