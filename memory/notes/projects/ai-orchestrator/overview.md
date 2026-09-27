# ai-orchestrator Overview

AI Orchestrator is a local-first coordination system built around FastAPI,
PostgreSQL/pgvector, filesystem workers, local model routing, and durable
project memory.

The current implementation direction is incremental: prove indexing and search,
improve code-aware retrieval, keep generated durable memories behind review,
and defer large framework or database migrations until there is measurement
evidence.
