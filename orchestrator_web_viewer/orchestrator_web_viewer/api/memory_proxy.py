"""Web viewer endpoints that proxy memory operations to the orchestrator."""
from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from orchestrator_web_viewer.integrations.orchestrator_client import (
    orchestrator_delete,
    orchestrator_get,
    orchestrator_post,
)

router = APIRouter()


class MemoryFeedbackPayload(BaseModel):
    memory_id: str
    feedback: int = Field(ge=-5, le=5)


class MemorySearchPayload(BaseModel):
    embedding: List[float]
    project_id: Optional[str] = None
    system_id: Optional[str] = None
    task_id: Optional[str] = None
    categories: Optional[List[str]] = None
    top_k: int = Field(default=5, ge=1, le=50)


class MemorySearchTextPayload(BaseModel):
    query: str
    project_id: Optional[str] = None
    categories: Optional[List[str]] = None
    top_k: int = Field(default=8, ge=1, le=50)


class MemoryAddPayload(BaseModel):
    content: str
    project_id: Optional[str] = None
    task_id: Optional[str] = None
    system_id: Optional[str] = None
    created_by: Optional[str] = None
    categories: Optional[List[str]] = None


@router.get("/items")
async def list_memory_items(
    project_id: Optional[str] = None,
    category: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    """Return memory items (proxies to orchestrator)."""
    params = {
        "limit": limit,
        "offset": offset,
    }
    if project_id:
        params["project_id"] = project_id
    if category:
        params["category"] = category
    if search:
        params["search"] = search
    return await orchestrator_get("/memory/items", params=params)


@router.get("/stats")
async def memory_stats():
    """Return memory stats."""
    return await orchestrator_get("/memory/stats")


@router.delete("/items/{memory_id}")
async def delete_memory(memory_id: str):
    """Delete a memory entry."""
    return await orchestrator_delete(f"/memory/items/{memory_id}")


@router.post("/feedback")
async def update_feedback(payload: MemoryFeedbackPayload):
    """Update user feedback for a memory item."""
    return await orchestrator_post("/memory/feedback", payload.dict())


@router.post("/search")
async def search_memory(payload: MemorySearchPayload):
    """Run a semantic search."""
    return await orchestrator_post("/memory/search", payload.dict())


@router.post("/search-text")
async def search_memory_text(payload: MemorySearchTextPayload):
    """Run a semantic search using a text query."""
    return await orchestrator_post("/memory/search-text", payload.dict())


@router.post("/items")
async def add_memory(payload: MemoryAddPayload):
    """Add a memory item with embeddings generated server-side."""
    return await orchestrator_post("/memory/items", payload.dict())


@router.post("/code-index/{project_id}")
async def queue_code_index(project_id: str, payload: dict):
    """Queue code indexing for a project."""
    return await orchestrator_post(f"/memory/code-index/{project_id}", payload)
