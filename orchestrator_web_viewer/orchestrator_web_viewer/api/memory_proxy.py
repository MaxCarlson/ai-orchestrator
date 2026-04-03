"""Web viewer endpoints that proxy memory operations to the orchestrator."""
from __future__ import annotations

from typing import Any
from typing import List, Optional

from fastapi import APIRouter, File, Form, Query, UploadFile
from pydantic import BaseModel, Field

from orchestrator_web_viewer.integrations.orchestrator_client import (
    orchestrator_delete,
    orchestrator_get,
    orchestrator_multipart_post,
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


class GlobalEmbeddingPayload(BaseModel):
    repo_path: Optional[str] = None
    repo_paths: Optional[List[str]] = None
    mode: str = "auto"
    code_model_id: Optional[str] = None
    text_model_id: Optional[str] = None
    force_reindex: bool = False
    approved: bool = False
    approved_by: Optional[str] = None


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


@router.get("/global/stats")
async def global_memory_stats():
    """Return global memory stats."""
    return await orchestrator_get("/memory/global/stats")


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


@router.post("/global/search-text")
async def search_global_memory_text(payload: MemorySearchTextPayload):
    """Run a semantic search using a text query (global)."""
    return await orchestrator_post("/memory/global/search-text", payload.dict())


@router.post("/items")
async def add_memory(payload: MemoryAddPayload):
    """Add a memory item with embeddings generated server-side."""
    return await orchestrator_post("/memory/items", payload.dict())


@router.get("/global/items")
async def list_global_memory_items(
    category: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    """Return global memory items."""
    params = {
        "limit": limit,
        "offset": offset,
    }
    if category:
        params["category"] = category
    if search:
        params["search"] = search
    return await orchestrator_get("/memory/global/items", params=params)


@router.post("/global/index")
async def queue_global_embeddings(payload: GlobalEmbeddingPayload):
    """Queue global embeddings for arbitrary paths."""
    return await orchestrator_post("/memory/global/index", payload.dict())


@router.get("/embedding-runs")
async def list_embedding_runs(
    status: Optional[str] = None,
    limit: int = Query(default=5, ge=1, le=50),
):
    """Return recent embedding runs."""
    params = {"limit": limit}
    if status:
        params["status"] = status
    return await orchestrator_get("/memory/embedding-runs", params=params)


@router.post("/code-index/{project_id}")
async def queue_code_index(project_id: str, payload: dict):
    """Queue code indexing for a project."""
    return await orchestrator_post(f"/memory/code-index/{project_id}", payload)


class TextSearchPayload(BaseModel):
    query: str
    top_k: int = 10
    use_reranker: bool = True
    table: str = "text_chunks"


class TextIndexPayload(BaseModel):
    repo_path: str
    mode: str = "text"
    target: str = "project"
    force_reindex: bool = False
    include_pdfs: bool = True


class IngestTextPayload(BaseModel):
    content: str
    source_label: str = "api_direct"


@router.post("/text-search/{project_id}")
async def text_search(project_id: str, payload: TextSearchPayload):
    """Run a text/semantic search over text chunks for a project."""
    return await orchestrator_post(f"/memory/text-search/{project_id}", payload.dict())


@router.post("/text-index/{project_id}")
async def text_index(project_id: str, payload: TextIndexPayload):
    """Queue text indexing for a project."""
    return await orchestrator_post(f"/memory/text-index/{project_id}", payload.dict())


@router.post("/ingest-text/{project_id}")
async def ingest_text(project_id: str, payload: IngestTextPayload):
    """Ingest raw text content directly into a project's text chunks."""
    return await orchestrator_post(f"/memory/ingest-text/{project_id}", payload.dict())


@router.get("/text-chunks/{project_id}")
async def list_text_chunks(
    project_id: str,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    file_path: Optional[str] = None,
):
    """Return text chunks for a project."""
    params: dict = {"limit": limit, "offset": offset}
    if file_path:
        params["file_path"] = file_path
    return await orchestrator_get(f"/memory/text-chunks/{project_id}", params=params)


@router.post("/upload-files/{project_id}")
async def upload_files(
    project_id: str,
    files: list[UploadFile] = File(...),
    replace_existing: bool = Form(False),
    dedupe_by_hash: bool = Form(False),
    reindex_if_same_name: bool = Form(False),
    conversation_format: str | None = Form(None),
):
    """Proxy multipart file upload into a project."""
    form_files: list[tuple[str, tuple[str, bytes, str]]] = []
    for upload in files:
        form_files.append(
            (
                "files",
                (
                    upload.filename or "upload",
                    await upload.read(),
                    upload.content_type or "application/octet-stream",
                ),
            )
        )
    data: dict[str, Any] = {
        "replace_existing": str(replace_existing).lower(),
        "dedupe_by_hash": str(dedupe_by_hash).lower(),
        "reindex_if_same_name": str(reindex_if_same_name).lower(),
    }
    if conversation_format:
        data["conversation_format"] = conversation_format
    return await orchestrator_multipart_post(
        f"/memory/upload-files/{project_id}",
        data=data,
        files=form_files,
    )


@router.get("/sources/{project_id}")
async def project_sources(project_id: str):
    """List project text sources."""
    return await orchestrator_get(f"/memory/sources/{project_id}")


@router.delete("/sources/{project_id}/{source_id}")
async def delete_source(project_id: str, source_id: str):
    """Delete a project text source."""
    return await orchestrator_delete(f"/memory/sources/{project_id}/{source_id}")


@router.post("/sources/{project_id}/{source_id}/reingest")
async def reingest_source(project_id: str, source_id: str):
    """Reingest a project text source."""
    return await orchestrator_post(f"/memory/sources/{project_id}/{source_id}/reingest", {})


@router.post("/sources/{project_id}/{source_id}/replace")
async def replace_source(
    project_id: str,
    source_id: str,
    file: UploadFile = File(...),
    conversation_format: str | None = Form(None),
):
    """Replace a project text source."""
    data = {}
    if conversation_format:
        data["conversation_format"] = conversation_format
    return await orchestrator_multipart_post(
        f"/memory/sources/{project_id}/{source_id}/replace",
        data=data,
        files=[(
            "file",
            (
                file.filename or "replacement",
                await file.read(),
                file.content_type or "application/octet-stream",
            ),
        )],
    )
