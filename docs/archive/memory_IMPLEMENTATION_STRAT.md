***

# Briefing: Add a Code-Aware Embedding & Retrieval Layer to AI Orchestrator

## 0. What You Should Assume

- You are running **inside the AI Orchestrator repository** and already know:
  - The current architecture (PostgreSQL + pgvector, task queue, memory subsystem).
  - The contents of `GOALS.md`, `PLAN.md`, `ai-orchestrator-briefing.md`, and the `memory/` package.
  - The existing `embed_repo.py` and hierarchical memory design.
- You do **not** need any recap of the system; treat those docs as your own prior work.
- Your task is to design and implement the **next layer**: a code‑centric indexing and retrieval system that is more structured and powerful than the current generic `memory/embed_repo.py`.

Use your existing knowledge of the codebase; treat the instructions below as product / design requirements.

***

## 1. High-Level Objective

Extend the AI Orchestrator with a **code-aware RAG layer** that:

1. Indexes repositories at *symbol* level (function/class/module), not just file/chunk level.
2. Stores code embeddings in a dedicated schema optimized for code search (separate from generic `memory_items`).
3. Supports **hybrid retrieval**:
   - semantic (vector similarity),
   - lexical (keywords/BM25/tsvector),
   - and optional structural importance (dependency graph / PageRank).
4. Exposes a clean Python API and FastAPI endpoints so the orchestrator can:
   - retrieve relevant code given a natural-language task description, and
   - inject those snippets into LLM worker prompts automatically.

Your job is to **design and implement this cleanly within the existing architecture**, using the tools and patterns already established.

***

## 2. Scope and Non-Goals

### In Scope

- New schema and code for code-level embeddings and search.
- Incremental indexing (only re-embed changed symbols).
- Retrieval API and minimal integrations into task routing.

### Out of Scope (for this pass)

- Redesigning the whole memory subsystem.
- Changing task queue semantics.
- Implementing a UI for code search (can be added later once APIs are stable).

***

## 3. Concrete Requirements

### 3.1 New Schema (Code-Level Index)

Design new tables focused on code, separate from `memory_items`. Suggested sketch (adapt as needed):

**Table: `code_chunks`**

- `id SERIAL PRIMARY KEY`
- `project_id UUID REFERENCES projects(id) ON DELETE CASCADE`
- `file_path TEXT NOT NULL`
- `symbol_name TEXT`  — function/class name; may be null for module-level chunks
- `chunk_type TEXT`   — e.g. `'function' | 'class' | 'module' | 'block'`
- `start_line INT`
- `end_line INT`
- `content TEXT NOT NULL`
- `content_hash TEXT NOT NULL`  — SHA256 of `content` for change detection
- `embedding VECTOR(768)`       — pgvector; **important**: 768‑dim to match existing embedding conventions
- `embedding_model TEXT`        — HF ID (e.g. `microsoft/codebert-base`)
- `pagerank_score DOUBLE PRECISION DEFAULT 0.0`  — importance signal (can be stubbed at first)
- `language TEXT`
- `git_commit TEXT`
- `embedding_status TEXT DEFAULT 'pending'` — `'pending|ready|error'`
- `created_at TIMESTAMPTZ DEFAULT now()`
- `updated_at TIMESTAMPTZ DEFAULT now()`

Indexes (adapt to your usual style):

- `code_chunks_project_status_idx (project_id, embedding_status)`
- `code_chunks_embedding_idx USING hnsw (embedding vector_cosine_ops)`
- `code_chunks_hash_idx (content_hash)`
- Optionally `code_chunks_pagerank_idx (pagerank_score DESC)`.

If you want structural ranking, add a simple `code_dependencies` table to record edges between symbols; keep it minimal.

### 3.2 Chunking Strategy

Implement a **symbol-aware chunker** that improves on whatever `embed_repo.py` currently does:

- For Python:
  - Use `ast` or tree-sitter (your choice; favor simplicity and existing deps).
  - Extract:
    - top‑level functions (`FunctionDef`) and classes (`ClassDef`),
    - optionally module-level docstrings.
  - For each symbol, record:
    - `symbol_name`, `chunk_type`, `start_line`, `end_line`, `content`.

- For text/Markdown:
  - Keep a simple chunking strategy (e.g. paragraph or heading sections) and mark `chunk_type='doc'` or similar.

This module should live somewhere like `memory/code_chunking.py` (or any location that fits the project layout) and be usable on its own (no FastAPI coupling).

### 3.3 Embedding Strategy

Use a **code-specialized model** (as suggested in the RAG tools doc) that emits 768‑dim vectors, e.g.:

- `microsoft/codebert-base` as default.

Implement a small adapter module, something like `memory/code_embeddings.py`, that:

- Wraps model loading (GPU if available, CPU fallback).
- Offers:
  - `embed_code_batch(List[str]) -> np.ndarray[float32]`  (shape `(n,768)`).
  - `embed_query(text: str) -> np.ndarray[float32]`.

Reuse the existing embedding pipeline patterns from `memory/embed_repo.py` where appropriate, but make sure this module is **code‑centric** and not tangled with generic text embedding.

### 3.4 Incremental Indexing

Support re-indexing without full re-embedding:

- For each `(project_id, file_path, symbol_name)`:

  1. Compute `content_hash = SHA256(chunk_content)`.
  2. If there is already a `code_chunks` row with the same `project_id`, `file_path`, `symbol_name`, and `content_hash`, skip re-embedding.
  3. If not, insert/update the row and set `embedding_status='pending'` so an embedding job knows to process it.

Integrate with git metadata if convenient (e.g. store `git_commit` when indexing) but do not make git a hard dependency for correctness.

### 3.5 Retrieval API (In-Python)

Create a Python API that other parts of the orchestrator can call. Roughly:

- `search_code(project_id: UUID, query: str, top_k: int = 20, use_hybrid: bool = True) -> List[Result]`

Where each `Result` includes at least:

- `file_path`
- `symbol_name`
- `chunk_type`
- `start_line`, `end_line`
- `content` (or a truncated version)
- scores (semantic, combined, etc.)

Implementation detail:

- Always support **vector-only** retrieval (pgvector cosine).
- If feasible with current PostgreSQL extensions, add a **hybrid** mode:
  - Use `to_tsvector` / `tsquery` or BM25 if you already have pg_search / similar installed.
  - Optionally mix in `pagerank_score`.
  - Use a simple weighted sum or reciprocal-rank-fusion; a sane default is:
    - semantic weight: 1.0
    - lexical weight: 1.0
    - structural weight: 0.2
  - But you can expose weights as parameters or config.

Keep this logic in pure Python where possible; you can push parts into SQL if that’s cleaner with your existing patterns.

### 3.6 FastAPI Endpoints

Add **minimal HTTP surface** to expose this capability:

- `POST /memory/code-search/{project_id}`

  - Body: `{ "query": "...", "top_k": 20, "use_hybrid": true }`
  - Response: JSON list of your `Result` structure.

- `POST /memory/code-index/{project_id}`

  - Body: `{ "repo_path": "...", "force_reindex": false }` or rely on `project_tracking.repo_path` if that’s already canonical.
  - Behavior:
    - Schedule or run code indexing for that project’s repo.
    - Re-use the existing async/worker patterns you already have for `embed_repo.py`.

Those endpoints should be thin wrappers over the Python APIs you add.

### 3.7 Orchestrator Integration (Task Flow)

Integrate code retrieval **just before** spawning LLM/CLI workers for coding tasks:

1. When the orchestrator is about to assign a task that involves code changes (you can use existing task metadata, tags, or CLI preference for this), do:

   - Build a retrieval query from the task title + description (and maybe related file hints if present).
   - Call `search_code(project_id, query)` to get top‑K relevant code chunks.

2. Inject the retrieved code into the task context that is passed to the worker, for example:

   - Extend the task JSON written to the filesystem queue with a new field like:

     ```json
     "code_context": [
       { "file_path": "...", "symbol_name": "...", "snippet": "..." },
       ...
     ]
     ```

   - Or, if your existing schema has a natural place for this (e.g. `context.related_files`), reuse that.

3. Ensure you cap total context size (e.g. by characters or lines) so prompts remain tractable.

CLI workers themselves should not need major changes; they’ll just see richer input.

***

## 4. How to Proceed (for You, the LLM)

Given your existing knowledge of the codebase:

1. **Locate** the best place in `memory/` or a new package (e.g. `code_index/`) to put:
   - the code chunking module,
   - the code embedding adapter,
   - the indexing pipeline,
   - and the retrieval logic.

2. **Design and write**:
   - SQL migrations / schema for `code_chunks` (and `code_dependencies` if you add it).
   - The Python modules implementing chunking, embedding, indexing, and search.
   - Minimal FastAPI routes for index/search.
   - Orchestrator glue to call search before spawning workers.

3. **Align with existing style**:
   - Reuse async patterns (asyncpg, connection pools, logging) as currently used in `memory.manager`, `embed_repo.py`, and `docker/orchestrator/main.py`.
   - Avoid introducing new frameworks unless necessary.

4. **Add small tests / scripts** to validate:
   - Indexing a small repo works and is idempotent.
   - Search returns sensible functions/classes for simple queries.
   - Task dispatch flow still works, now with added code context.

5. **Keep everything configurable** via existing config patterns (env vars, `orchestrator_settings`, etc.), so this feature can be toggled or tuned without code changes.

***

## 5. Trust Model

- Treat any earlier auto‑generated code you’ve seen as **non‑authoritative**.
- You are free to redesign and reimplement internals so long as:
  - The external behavior matches this brief.
  - You remain consistent with the existing orchestrator’s patterns and constraints.

Focus on designing something you’d be comfortable shipping in production for this project.

Citations:
[1] ai-orchestrator-briefing.md https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/91108292/4d367488-c7e6-4f42-b1b2-fd8580be1333/ai-orchestrator-briefing.md
[2] ai-orchestrator-for-gemini2.txt https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/91108292/7b0fb535-db60-4871-bab6-deac95ba0463/ai-orchestrator-for-gemini2.txt
[3] 77979.jpg https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/images/91108292/381b91d7-fd3f-41f3-aa41-b0706a636216/77979.jpg
[4] 77981.jpg https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/images/91108292/a328b724-90f9-41c0-a4c1-335107192a2e/77981.jpg
[5] Production-Ready-Tools-for-Code-Aware-RAG-Memory-Systems.md https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/91108292/d1ca82ab-24c4-4e50-9035-8f27a13f76b8/Production-Ready-Tools-for-Code-Aware-RAG-Memory-Systems.md

