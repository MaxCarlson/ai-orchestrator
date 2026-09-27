-- Project Tracking Schema
-- Tracks project memory and embedding status

CREATE TABLE IF NOT EXISTS project_tracking (
    project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    is_tracked BOOLEAN NOT NULL DEFAULT FALSE,
    repo_path TEXT,
    repo_paths TEXT,
    embedding_status TEXT NOT NULL DEFAULT 'not_tracked',
    embedding_last_indexed TIMESTAMPTZ,
    preferred_model_id TEXT,
    embedding_model_id TEXT,
    text_embedding_model_id TEXT,
    embedding_mode TEXT,
    global_embedding_status TEXT NOT NULL DEFAULT 'not_tracked',
    global_embedding_last_indexed TIMESTAMPTZ,
    global_code_model_id TEXT,
    global_text_model_id TEXT,
    global_embedding_mode TEXT,
    embedding_stats JSONB,
    global_embedding_stats JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_tracking_status ON project_tracking(embedding_status);
CREATE INDEX IF NOT EXISTS idx_project_tracking_last_indexed ON project_tracking(embedding_last_indexed);
