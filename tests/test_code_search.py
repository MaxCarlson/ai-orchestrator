import numpy as np
import pytest

from memory import models
from memory.code_search import _rrf_merge_code_results, search_code


def test_code_search_rrf_prefers_results_found_by_dense_and_lexical():
    dense = [
        {
            "id": 1,
            "file_path": "memory/code_search.py",
            "symbol_name": "dense_code_search",
            "similarity": 0.9,
            "lexical_score": 0.0,
        },
        {
            "id": 2,
            "file_path": "memory/retrieval.py",
            "symbol_name": "hybrid_search",
            "similarity": 0.8,
            "lexical_score": 0.0,
        },
    ]
    lexical = [
        {
            "id": 2,
            "file_path": "memory/retrieval.py",
            "symbol_name": "hybrid_search",
            "similarity": 0.0,
            "lexical_score": 0.7,
        },
        {
            "id": 3,
            "file_path": "memory/models.py",
            "symbol_name": "<module>",
            "similarity": 0.0,
            "lexical_score": 0.6,
        },
    ]

    merged = _rrf_merge_code_results(dense, lexical)

    assert merged[0]["id"] == 2
    assert merged[0]["rrf_score"] > merged[1]["rrf_score"]


class FakeConn:
    def __init__(self):
        self.calls = []

    async def fetch(self, sql, *args):
        self.calls.append((sql, args))
        if "ORDER BY embedding <=> $1" in sql:
            return [
                {
                    "id": 1,
                    "file_path": "memory/code_search.py",
                    "symbol_name": "search_code",
                    "chunk_type": "function",
                    "start_line": 1,
                    "end_line": 20,
                    "content": "dense",
                    "similarity": 0.9,
                    "lexical_score": 0.0,
                }
            ]
        return [
            {
                "id": 1,
                "file_path": "memory/code_search.py",
                "symbol_name": "search_code",
                "chunk_type": "function",
                "start_line": 1,
                "end_line": 20,
                "content": "lexical",
                "similarity": 0.0,
                "lexical_score": 0.5,
            }
        ]


@pytest.mark.asyncio
async def test_search_code_queries_dense_and_postgres_fts():
    conn = FakeConn()

    results = await search_code(
        conn,
        "project-1",
        "search_code exact identifier",
        np.array([0.1, 0.2], dtype=np.float32),
        top_k=5,
    )

    assert results[0]["file_path"] == "memory/code_search.py"
    assert results[0]["rrf_score"] > 0
    assert len(conn.calls) == 2
    assert "websearch_to_tsquery('simple', $2)" in conn.calls[1][0]
    assert conn.calls[1][1][1] == "search_code exact identifier"


def test_code_chunk_schema_includes_fts_search_vector_and_gin_indexes():
    assert "search_vector tsvector GENERATED ALWAYS AS" in models.CREATE_CODE_CHUNKS_TABLE
    assert "idx_code_chunks_search_vector" in models.CREATE_CODE_CHUNKS_INDEXES
    assert "idx_global_code_chunks_search_vector" in models.CREATE_GLOBAL_CODE_CHUNKS_INDEXES
    assert "ADD COLUMN IF NOT EXISTS search_vector" in models.ALTER_CODE_CHUNKS_SEARCH_VECTOR
