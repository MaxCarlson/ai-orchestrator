# Hierarchical Memory Subsystem

This directory implements the **Hierarchical Memory System** for the AI Orchestrator.

The goal of this subsystem is to provide **long-lived, structured, vector-searchable memory**
that can be:

- Shared across LLMs and CLIs
- Organized hierarchically (Global → Projects → Tasks → Categories)
- Stored centrally in **PostgreSQL + pgvector**
- Populated automatically by the orchestrator or manually by the user
- Continuously refined via usage, decay, and explicit feedback

This is **not** a chat history store.

This is **working memory + long-term knowledge** for the orchestrator ecosystem.

---

## High-Level Architecture

PostgreSQL
- memory_items (content + embedding + metadata)
- categories (semantic / user-defined groupings)
- memory_categories (many-to-many mapping)
- vector index (pgvector)

RTX 5090
- Code embedding models
- Text / design embedding models
- Batch indexing jobs

AI Orchestrator
- Decides what becomes memory
- Enforces quotas and retention
- Routes memory into LLM prompts
- Accepts user feedback on memory quality

---

## Files in This Directory

### __init__.py
Package marker for the memory subsystem.

### models.py
Defines the PostgreSQL schema for:
- memory_items
- categories
- memory_categories
- vector indexes (pgvector)

This file is the **authoritative schema definition**.

### vector_store.py
Vector search abstraction layer.

Current implementation:
- PostgreSQL + pgvector
- Cosine similarity
- SQL metadata filtering

Designed so that Qdrant / Weaviate / Milvus can replace pgvector later.

### manager.py
High-level MemoryManager API.

Responsibilities:
- Schema initialization
- Memory insertion
- Similarity search
- Access tracking
- User feedback handling

This is the primary interface used by:
- Orchestrator
- CLI tools
- LLM agents

### embed_repo.py
GPU-powered repository indexing tool.

Responsibilities:
- Walk a repository tree
- Classify files (code vs prose)
- Chunk content
- Generate embeddings using specialized models
- Store embeddings as project-scoped memories

Designed to run on the **RTX 5090** as a background job.

---

## Memory Hierarchy Model

Memories are logically organized as:

Global
- System
- Projects
  - Project A
    - Tasks
      - Subtasks
  - Project B
- Categories
  - Physics
  - PostgreSQL
  - CUDA

Important notes:
- Hierarchy is **logical**, not rigidly enforced
- Relationships are expressed via metadata + categories
- A memory may belong to multiple categories
- Project quotas and category quotas are enforced independently

---

## What This Folder Does NOT Do (Yet)

- Does not auto-run at orchestrator startup
- Does not yet enforce eviction or decay
- Does not expose FastAPI endpoints by itself
- Does not enqueue indexing jobs automatically

Those responsibilities belong to the **AI Orchestrator** and **task queue**.

---

## Intended Usage Flow

1. User creates a project via kmtui
2. User or orchestrator requests repository indexing
3. Orchestrator enqueues a task
4. embed_repo.py runs on the RTX 5090
5. Embeddings are stored in PostgreSQL
6. LLMs and CLIs query memory directly
7. Orchestrator monitors usage and feedback
8. Memory is retained, decayed, or evicted

---

## Design Principles

- PostgreSQL is the source of truth
- Vector DB is an implementation detail
- Memory decisions are agent-driven
- Users are always informed when memory is created
- Users can override memory decisions

---

## Status

- Schema defined
- Vector search implemented
- GPU embedding pipeline implemented
- Orchestrator integration pending
- Task queue wiring pending
- Retention enforcement pending

See PLAN.md for integration steps.
