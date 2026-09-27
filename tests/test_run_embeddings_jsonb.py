"""JSONB parameter regression tests for the embedding runner."""

import asyncio
import json

from memory import run_embeddings


class RecordingConnection:
    def __init__(self):
        self.calls = []

    async def execute(self, query, *args):
        self.calls.append((query, args))


def test_finish_run_serializes_stats_for_asyncpg_jsonb():
    conn = RecordingConnection()
    stats = {"mode": "code", "chunks_indexed": 1}

    asyncio.run(run_embeddings._finish_run(conn, "run-id", "ready", stats))

    encoded = conn.calls[0][1][2]
    assert isinstance(encoded, str)
    assert json.loads(encoded) == stats


def test_progress_update_serializes_stats_for_asyncpg_jsonb():
    conn = RecordingConnection()
    stats = {"mode": "code"}
    progress = {"files_processed": 1, "files_total": 2}

    asyncio.run(run_embeddings._update_run_progress(conn, "run-id", stats, progress))

    encoded = conn.calls[0][1][1]
    assert isinstance(encoded, str)
    assert json.loads(encoded) == {"mode": "code", "progress": progress}


def test_project_tracking_serializes_optional_jsonb_stats():
    conn = RecordingConnection()
    stats = {"code": {"chunks_indexed": 1}}

    asyncio.run(
        run_embeddings._update_project_tracking(
            conn,
            "project-id",
            target="both",
            mode="code",
            code_model="code-model",
            text_model="text-model",
            status="ready",
            embedding_stats=stats,
            global_embedding_stats=None,
        )
    )

    assert len(conn.calls) == 2
    project_jsonb = conn.calls[0][1][5]
    global_jsonb = conn.calls[1][1][5]
    assert isinstance(project_jsonb, str)
    assert json.loads(project_jsonb) == stats
    assert global_jsonb is None
