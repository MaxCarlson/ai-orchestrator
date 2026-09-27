import numpy as np
import pytest

from memory import models
from memory.kinds import DEFAULT_MEMORY_KIND, MEMORY_KINDS, validate_memory_kind
from memory.manager import MemoryManager


def test_memory_kind_taxonomy_contains_expected_values():
    assert DEFAULT_MEMORY_KIND == "project_fact"
    assert {
        "constraint",
        "preference",
        "decision",
        "project_fact",
        "code_note",
        "bug_note",
        "session_summary",
        "open_question",
    } <= MEMORY_KINDS


def test_validate_memory_kind_rejects_unknown_kind():
    with pytest.raises(ValueError, match="Invalid memory kind"):
        validate_memory_kind("random_note")


def test_memory_schema_adds_kind_columns_and_indexes():
    assert "kind TEXT NOT NULL DEFAULT 'project_fact'" in models.CREATE_MEMORY_TABLE
    assert "kind TEXT NOT NULL DEFAULT 'project_fact'" in models.CREATE_GLOBAL_MEMORY_TABLE
    assert "idx_memory_items_kind" in models.ALTER_MEMORY_KIND_COLUMNS
    assert "idx_global_memory_items_kind" in models.ALTER_MEMORY_KIND_COLUMNS


class CaptureStore:
    def __init__(self):
        self.filters = None

    async def query(self, *, conn, table, vector, filters=None, top_k=5):
        self.filters = filters
        return []


class FakeConn:
    async def execute(self, *args):
        return "UPDATE 0"


@pytest.mark.asyncio
async def test_memory_manager_search_adds_kind_filter():
    store = CaptureStore()
    manager = MemoryManager(store=store)

    results = await manager.search(
        FakeConn(),
        embedding=np.array([0.1, 0.2], dtype=np.float32),
        project_id="project-1",
        kinds=["decision", "constraint"],
    )

    assert results == []
    assert "project_id = 'project-1'" in store.filters
    assert "kind IN ('decision', 'constraint')" in store.filters
