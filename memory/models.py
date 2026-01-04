"""
Database schema definitions for the hierarchical memory system.

These constants define the SQL statements required to create the
``memory_items``, ``categories`` and ``memory_categories`` tables
within the PostgreSQL database used by the orchestrator. They can be
executed via ``asyncpg`` as part of the initialization phase of the
memory subsystem. The design follows the schema outlined in the
hierarchical memory specification:

    - ``memory_items`` stores individual memory entries along with
      their semantic embedding and context identifiers.
    - ``categories`` enumerates topical categories that can be applied
      to memories. Categories may form a hierarchy via the
      ``parent_id`` column.
    - ``memory_categories`` maps memory items to categories in a
      many‑to‑many relationship.

The ``embedding`` column uses the ``vector`` type provided by
``pgvector``. An index is created using the ``ivfflat`` index type
with cosine distance for efficient nearest‑neighbour queries. See
``README.md`` for instructions on enabling the pgvector extension.
"""

# SQL statements to create tables and indexes

CREATE_SYSTEM_TABLE = """
CREATE TABLE IF NOT EXISTS systems (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_systems_name ON systems ((LOWER(name)));
"""

UPSERT_DEFAULT_SYSTEM = """
INSERT INTO systems (name, description)
VALUES ('global', 'Default global orchestration scope')
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description,
    modified_at = NOW();
"""

CREATE_MEMORY_TABLE = """
CREATE TABLE IF NOT EXISTS memory_items (
    memory_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content TEXT NOT NULL,
    embedding vector(768) NOT NULL,
    project_id UUID NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id UUID NULL REFERENCES tasks(id) ON DELETE CASCADE,
    system_id UUID NULL REFERENCES systems(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    access_count INTEGER NOT NULL DEFAULT 0,
    user_feedback SMALLINT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE
);
"""

CREATE_CATEGORY_TABLE = """
CREATE TABLE IF NOT EXISTS categories (
    category_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    parent_id UUID NULL REFERENCES categories(category_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""

CREATE_MEMORY_CATEGORY_TABLE = """
CREATE TABLE IF NOT EXISTS memory_categories (
    memory_id UUID NOT NULL REFERENCES memory_items(memory_id) ON DELETE CASCADE,
    category_id UUID NOT NULL REFERENCES categories(category_id) ON DELETE CASCADE,
    PRIMARY KEY (memory_id, category_id)
);
"""

CREATE_EMBEDDING_INDEX = """
-- Use the ivfflat index for efficient vector search with cosine
-- similarity. The index creation might fail if pgvector is not
-- installed; ensure ``CREATE EXTENSION IF NOT EXISTS vector;`` has
-- been run beforehand. Adjust the ``lists`` parameter based on your
-- dataset size (larger lists yield better accuracy at the cost of
-- slower index build time).
CREATE INDEX IF NOT EXISTS idx_memory_items_embedding
ON memory_items USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
"""

ALTER_MEMORY_EMBEDDING_DIMENSION = """
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'memory_items'
          AND column_name = 'embedding'
          AND udt_name = 'vector'
    ) THEN
        BEGIN
            EXECUTE 'ALTER TABLE memory_items ALTER COLUMN embedding TYPE vector(768)';
        EXCEPTION
            WHEN others THEN
                -- Ignore errors if column already has dimension or table absent.
                NULL;
        END;
    END IF;
END $$;
"""
