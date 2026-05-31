# Hierarchical Memory Subsystem

This directory implements the **Hierarchical Memory System** for the AI Orchestrator.

The goal is to provide **long-lived, structured, vector-searchable memory** that can be:

- Shared across LLMs and CLIs
- Organized hierarchically (Global → Projects → Tasks → Categories)
- Stored centrally in **PostgreSQL + pgvector**
- Populated automatically by the orchestrator or manually by the user
- Continuously refined via usage, decay, and explicit feedback

This is **not** a chat history store. This is working memory + long-term knowledge for the orchestrator ecosystem.

---

## High-Level Architecture

```
RTX 5090
  └─ code_chunking / code_embeddings / embed_repo
       └─ code_chunks (768-dim, CodeBERT)

source_ingestion / langchain_loaders+splitters
  └─ text_chunks (768-dim, BGE)

memory_items
  └─ durable named memories (decisions, notes, session summaries)

retrieval.py
  ├─ dense_search()      pgvector cosine similarity
  ├─ BM25 sparse         rank-bm25, 5-min in-process cache
  ├─ _rrf_merge()        Reciprocal Rank Fusion
  └─ hybrid_search()     RRF → optional CrossEncoder reranking → top-k

AI Orchestrator (FastAPI)
  └─ manages task dispatch, quota enforcement, API surface

MemoryManager (manager.py)
  └─ insert / search / feedback / access tracking over memory_items
```

---

## Files in This Directory

### `__init__.py`
Package marker.

### `models.py`
Authoritative PostgreSQL schema. Tables defined here:
- `memory_items` — durable named memories with embedding, project/task/system scope, access count, and user feedback
- `global_memory_items` — cross-project memories keyed by `source_key`
- `categories` / `memory_categories` — many-to-many category tagging on `memory_items`
- `global_memory_categories` — same for global items
- `code_chunks` / `global_code_chunks` — AST-chunked code with 768-dim CodeBERT embeddings
- `text_chunks` / `global_text_chunks` — prose/doc chunks with 768-dim BGE embeddings
- `project_text_sources` — registry of ingested source files per project
- `embedding_models` — registry seeded with BGE (text), CodeBERT (code), ms-marco (rerank)
- `embedding_runs` — audit log of indexing jobs

### `vector_store.py`
Low-level pgvector abstraction (`VectorStore` / `PgVectorStore`). Cosine similarity via the `<=>` operator. Prefer `retrieval.py` for new code.

### `retrieval.py`
**Primary retrieval interface.** Call `hybrid_search()` for all new retrieval.

- `dense_search()` — pgvector cosine similarity on `text_chunks` or `global_text_chunks`
- BM25 sparse retrieval via `rank-bm25` with a 5-minute in-process TTL cache
- `_rrf_merge()` — Reciprocal Rank Fusion (k=60) combining dense and sparse lists
- `hybrid_search()` — dense + BM25 + RRF + optional CrossEncoder reranking → top-k results with `similarity`, `bm25_score`, `rrf_score`, `rerank_score`
- `invalidate_bm25_cache()` — call after any ingest to keep BM25 fresh

### `manager.py`
High-level `MemoryManager` API over `memory_items`.

- `initialize_schema()` — idempotent schema creation; safe to run on startup
- `add_memory()` — insert a memory item with optional categories
- `search()` — cosine similarity search with project/system/task/category filters; updates access count on every hit
- `update_feedback()` — record user feedback score (positive = valuable, negative = bad)

Use `memory_items` for durable named memories. For code/text RAG retrieval use `code_chunks`/`text_chunks` via `retrieval.py`.

### `source_ingestion.py`
Ingestion pipeline for project text sources. Handles `.md`, `.txt`, `.rst`, `.pdf`, `.json`/`.ndjson` (conversation exports). Tracks ingested files in `project_text_sources`, stores chunks in `text_chunks`. Supports project-scoped and global-scoped ingestion.

### `code_chunking.py`
AST-based Python chunker. Produces symbol-level chunks (functions, classes, methods) with safe fallbacks for unparseable files.

### `code_embeddings.py`
CodeBERT (768-dim) embedder with GPU/CPU fallback. Used by `code_indexer.py`.

### `code_indexer.py`
Incremental hash-based indexer. Skips files whose content hash matches an existing `code_chunks` row; only re-embeds changed symbols.

### `code_search.py`
Vector search over `code_chunks` for a given project.

### `embed_repo.py`
GPU-powered repository indexing tool. Walks a repo tree, classifies files (code vs prose), chunks, embeds, and stores as project-scoped memories. Designed to run on the RTX 5090 as a background job.

### `conversation_ingest.py`
Normalizes and ingests conversation exports (Claude, ChatGPT, etc.) into `text_chunks`.

### `langchain_loaders.py` / `langchain_splitters.py`
LangChain document loaders and text splitters used by `source_ingestion.py`.

### `model_registry.py` / `text_embeddings.py`
Embedding model loading and inference helpers. Models are registered in the `embedding_models` DB table.

---

## Memory Hierarchy Model

Memories are logically organized as:

```
Global
└─ Projects
   ├─ Project A
   │  └─ Tasks / Subtasks
   └─ Project B
Categories (cross-cutting)
   ├─ Physics
   ├─ PostgreSQL
   └─ CUDA
```

- Hierarchy is **logical**, not rigidly enforced in the schema
- Relationships are expressed via `project_id`, `task_id`, and the `memory_categories` join table
- A memory may belong to multiple categories
- `memory_items` vs `global_memory_items`: project-scoped vs cross-project

---

## Retrieval Pipeline

```
user query
    │
    ├─► dense_search()     pgvector cosine similarity
    │
    ├─► BM25 sparse        rank-bm25, 5-min TTL cache, tokenized content
    │
    ├─► _rrf_merge()       Reciprocal Rank Fusion (k=60)
    │
    └─► hybrid_search()    RRF candidates → optional CrossEncoder reranking
                           → top-k with similarity / bm25_score / rrf_score
```

---

## Design Principles

- PostgreSQL is the source of truth; the vector index is regenerable
- `VectorStore` is an abstraction — pgvector is the current implementation
- Memory decisions are agent-driven but human-approved; nothing is auto-written to `memory_items` without review
- Retrieved context is labeled as data, never as instructions

---

## Status

See `PLAN.md` for what is not yet implemented and the sequenced steps to get there.
