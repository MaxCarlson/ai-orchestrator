"""
Hierarchical memory subsystem for the AI Orchestrator.

This package provides an interface to store, retrieve and manage
contextual memories for projects, systems, tasks and categories. It
leverages PostgreSQL with the ``pgvector`` extension to store
semantic embeddings alongside metadata so that semantic search can be
performed directly inside the database. All operations use
``asyncpg`` to integrate seamlessly with the existing orchestrator,
which already maintains an asynchronous connection pool.

Public API:
    - :func:`initialize_schema`: Create memory tables if they do not exist.
    - :class:`MemoryManager`: High‑level methods for adding, searching and
      updating memories.

To extend this module or switch vector storage backend (e.g. to a
dedicated vector database), see :mod:`memory.vector_store` for an
abstract interface. The current implementation targets pgvector but
could be swapped out by providing a drop‑in replacement class.

See the documentation in the design specification for an overview of
the memory hierarchy and retention policies.
"""

from .manager import MemoryManager, initialize_schema  # noqa: F401
