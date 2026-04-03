"""Shared source-backed ingestion service for project text sources."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterable

import asyncpg

from memory.conversation_ingest import normalize_conversation_content
from memory.retrieval import invalidate_bm25_cache


if TYPE_CHECKING:
    from langchain_core.documents import Document


DEFAULT_UPLOAD_ROOT = Path(os.getenv("AI_ORCHESTRATOR_UPLOAD_ROOT", "/tmp/ai-orchestrator-uploads"))
MAX_UPLOAD_BYTES = int(os.getenv("AI_ORCHESTRATOR_MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
SUPPORTED_TEXT_EXTENSIONS = {".txt", ".md", ".rst", ".markdown"}
SUPPORTED_CONVERSATION_EXTENSIONS = {".txt", ".md", ".json", ".ndjson"}
SUPPORTED_FILE_EXTENSIONS = SUPPORTED_TEXT_EXTENSIONS | {".pdf", ".json", ".ndjson"}
FILENAME_CLEAN_RE = re.compile(r"[^A-Za-z0-9._-]+")
GLOBAL_RAG_PROJECT_ID = "00000000-0000-0000-0000-000000000000"


def is_global_scope(project_id: str) -> bool:
    return str(project_id) == GLOBAL_RAG_PROJECT_ID


def sanitize_filename(filename: str) -> str:
    base = Path(filename or "upload").name
    stem = FILENAME_CLEAN_RE.sub("-", base).strip("-.") or "upload"
    return stem[:180]


def compute_sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def detect_source_type(filename: str, *, conversation: bool = False) -> str:
    ext = Path(filename).suffix.lower()
    if conversation or ext in {".json", ".ndjson"}:
        return "conversation_export"
    if ext == ".pdf":
        return "pdf"
    if ext in {".md", ".markdown"}:
        return "markdown"
    if ext in {".txt", ".rst"}:
        return "plain_text"
    raise ValueError(f"Unsupported file type: {ext or 'unknown'}")


async def _fetch_source(conn: asyncpg.Connection, project_id: str, source_id: str) -> asyncpg.Record | None:
    return await conn.fetchrow(
        """
        SELECT *
        FROM project_text_sources
        WHERE project_id = $1 AND id = $2
        """,
        project_id,
        source_id,
    )


async def _fetch_source_by_label(conn: asyncpg.Connection, project_id: str, source_label: str) -> asyncpg.Record | None:
    return await conn.fetchrow(
        """
        SELECT *
        FROM project_text_sources
        WHERE project_id = $1 AND source_label = $2
        """,
        project_id,
        source_label,
    )


async def _fetch_source_by_hash(
    conn: asyncpg.Connection,
    project_id: str,
    sha256: str,
    source_type: str,
) -> asyncpg.Record | None:
    return await conn.fetchrow(
        """
        SELECT *
        FROM project_text_sources
        WHERE project_id = $1 AND sha256 = $2 AND source_type = $3
        ORDER BY created_at DESC
        LIMIT 1
        """,
        project_id,
        sha256,
        source_type,
    )


async def list_project_sources(pool: asyncpg.Pool, project_id: str) -> list[dict[str, Any]]:
    async with pool.acquire() as conn:
        if is_global_scope(project_id):
            rows = await conn.fetch(
                """
                SELECT
                    s.*,
                    COUNT(gtc.id) AS chunk_count
                FROM project_text_sources s
                LEFT JOIN global_text_chunks gtc
                    ON gtc.source_project_id = s.project_id
                   AND gtc.source_id = s.id
                WHERE s.project_id = $1
                GROUP BY s.id
                ORDER BY s.created_at DESC
                """,
                project_id,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT
                    s.*,
                    COUNT(tc.id) AS chunk_count
                FROM project_text_sources s
                LEFT JOIN text_chunks tc
                    ON tc.project_id = s.project_id
                   AND tc.source_id = s.id
                WHERE s.project_id = $1
                GROUP BY s.id
                ORDER BY s.created_at DESC
                """,
                project_id,
            )
    return [dict(row) for row in rows]


async def _delete_chunks_for_source(conn: asyncpg.Connection, project_id: str, source_id: str) -> None:
    if not is_global_scope(project_id):
        await conn.execute(
            "DELETE FROM text_chunks WHERE project_id = $1 AND source_id = $2",
            project_id,
            source_id,
        )
    await conn.execute(
        "DELETE FROM global_text_chunks WHERE source_project_id = $1 AND source_id = $2",
        project_id,
        source_id,
    )


async def delete_project_source(
    pool: asyncpg.Pool,
    project_id: str,
    source_id: str,
    *,
    delete_stored_file: bool = True,
) -> dict[str, Any]:
    async with pool.acquire() as conn:
        row = await _fetch_source(conn, project_id, source_id)
        if not row:
            raise ValueError("Source not found")
        stored_path = row["stored_path"]
        await _delete_chunks_for_source(conn, project_id, source_id)
        await conn.execute(
            "DELETE FROM project_text_sources WHERE project_id = $1 AND id = $2",
            project_id,
            source_id,
        )
    if is_global_scope(project_id):
        invalidate_bm25_cache("global_text_chunks", "source_key", project_id)
    else:
        invalidate_bm25_cache("text_chunks", "project_id", project_id)
    if delete_stored_file and stored_path:
        try:
            Path(stored_path).unlink(missing_ok=True)
            parent = Path(stored_path).parent
            if parent.exists():
                try:
                    parent.rmdir()
                except OSError:
                    pass
        except OSError:
            pass
    return {"status": "deleted", "source_id": source_id}


def _storage_path(project_id: str, source_id: str, original_filename: str, storage_root: Path) -> Path:
    return storage_root / "project_uploads" / project_id / source_id / sanitize_filename(original_filename)


async def _upsert_source(
    conn: asyncpg.Connection,
    *,
    project_id: str,
    source_label: str,
    source_type: str,
    original_filename: str | None,
    stored_path: str | None,
    mime_type: str | None,
    sha256: str | None,
    ingest_method: str,
    status: str,
    metadata: dict[str, Any] | None = None,
    source_id: str | None = None,
) -> str:
    payload = json.dumps(metadata or {})
    if source_id:
        row = await conn.fetchrow(
            """
            UPDATE project_text_sources
            SET source_label = $3,
                source_type = $4,
                original_filename = $5,
                stored_path = $6,
                mime_type = $7,
                sha256 = $8,
                ingest_method = $9,
                status = $10,
                metadata = $11::jsonb,
                updated_at = NOW()
            WHERE project_id = $1 AND id = $2
            RETURNING id
            """,
            project_id,
            source_id,
            source_label,
            source_type,
            original_filename,
            stored_path,
            mime_type,
            sha256,
            ingest_method,
            status,
            payload,
        )
        if row:
            return str(row["id"])

    row = await conn.fetchrow(
        """
        INSERT INTO project_text_sources (
            project_id, source_label, source_type, original_filename,
            stored_path, mime_type, sha256, ingest_method, status, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
        ON CONFLICT (project_id, source_label)
        DO UPDATE SET
            source_type = EXCLUDED.source_type,
            original_filename = EXCLUDED.original_filename,
            stored_path = EXCLUDED.stored_path,
            mime_type = EXCLUDED.mime_type,
            sha256 = EXCLUDED.sha256,
            ingest_method = EXCLUDED.ingest_method,
            status = EXCLUDED.status,
            metadata = EXCLUDED.metadata,
            updated_at = NOW()
        RETURNING id
        """,
        project_id,
        source_label,
        source_type,
        original_filename,
        stored_path,
        mime_type,
        sha256,
        ingest_method,
        status,
        payload,
    )
    return str(row["id"])


def _load_single_file_document(path: Path, source_type: str) -> Iterable["Document"]:
    if source_type == "pdf":
        try:
            from langchain_community.document_loaders import UnstructuredPDFLoader

            loader = UnstructuredPDFLoader(str(path))
            docs = loader.load()
        except ImportError as exc:
            raise ValueError("PDF ingestion requires the 'unstructured' package") from exc
        for doc in docs:
            doc.metadata["source_type"] = "pdf"
            doc.metadata["source"] = str(path)
        return docs

    try:
        from langchain_community.document_loaders import TextLoader
    except ImportError as exc:
        raise ValueError("Text ingestion requires the 'langchain_community' package") from exc

    loader = TextLoader(str(path), encoding="utf-8")
    docs = loader.load()
    metadata_type = "markdown" if path.suffix.lower() in {".md", ".markdown"} else "file"
    for doc in docs:
        doc.metadata["source_type"] = metadata_type
        doc.metadata["source"] = str(path)
    return docs


async def _ingest_source_content(
    pool: asyncpg.Pool,
    *,
    project_id: str,
    source_id: str,
    source_label: str,
    source_type: str,
    stored_path: Path,
    conversation_format: str | None = None,
) -> int:
    from memory.ingest_pipeline import ingest_text_direct

    if source_type == "conversation_export":
        text = stored_path.read_text(encoding="utf-8")
        normalized = normalize_conversation_content(text, fmt=conversation_format or stored_path.suffix.lstrip("."))
        ingest_kwargs = {}
        if is_global_scope(project_id):
            ingest_kwargs = {
                "table": "global_text_chunks",
                "owner_column": "source_key",
                "owner_id": project_id,
                "source_project_id": project_id,
            }
        return await ingest_text_direct(
            normalized.content,
            source_label=source_label,
            project_id=project_id,
            pool=pool,
            source_id=source_id,
            source_type="conversation_export",
            chunk_type="conversation_turns",
            header_context=normalized.title or "Conversation",
            **ingest_kwargs,
        )

    docs = list(_load_single_file_document(stored_path, source_type))
    if not docs:
        return 0

    combined_text = "\n\n".join(doc.page_content for doc in docs if doc.page_content.strip())
    if not combined_text.strip():
        return 0
    ingest_kwargs = {}
    if is_global_scope(project_id):
        ingest_kwargs = {
            "table": "global_text_chunks",
            "owner_column": "source_key",
            "owner_id": project_id,
            "source_project_id": project_id,
        }
    return await ingest_text_direct(
        combined_text,
        source_label=str(stored_path),
        project_id=project_id,
        pool=pool,
        source_id=source_id,
        source_type=source_type,
        chunk_type="pdf_page" if source_type == "pdf" else None,
        header_context=source_label,
        **ingest_kwargs,
    )


async def ingest_bytes_as_source(
    pool: asyncpg.Pool,
    *,
    project_id: str,
    filename: str,
    data: bytes,
    source_label: str | None = None,
    ingest_method: str,
    conversation: bool = False,
    conversation_format: str | None = None,
    replace_existing: bool = False,
    dedupe_by_hash: bool = False,
    storage_root: Path = DEFAULT_UPLOAD_ROOT,
) -> dict[str, Any]:
    if len(data) > MAX_UPLOAD_BYTES:
        raise ValueError(f"File exceeds max upload size of {MAX_UPLOAD_BYTES} bytes")

    safe_name = sanitize_filename(filename)
    source_type = detect_source_type(safe_name, conversation=conversation)
    suffix = Path(safe_name).suffix.lower()
    if suffix not in SUPPORTED_FILE_EXTENSIONS and source_type != "conversation_export":
        raise ValueError(f"Unsupported file type: {suffix}")
    if source_type == "conversation_export" and suffix not in SUPPORTED_CONVERSATION_EXTENSIONS:
        raise ValueError(f"Unsupported conversation file type: {suffix}")

    sha256 = compute_sha256_bytes(data)
    mime_type = mimetypes.guess_type(safe_name)[0] or "application/octet-stream"
    source_label = source_label or Path(safe_name).stem

    async with pool.acquire() as conn:
        existing = await _fetch_source_by_label(conn, project_id, source_label)
        if dedupe_by_hash:
            dup = await _fetch_source_by_hash(conn, project_id, sha256, source_type)
            if dup:
                return {"status": "deduped", "source_id": str(dup["id"]), "source_label": dup["source_label"]}
        if existing and not replace_existing:
            source_id = str(existing["id"])
        else:
            source_id = str(existing["id"]) if existing else None
        source_id = await _upsert_source(
            conn,
            project_id=project_id,
            source_id=source_id,
            source_label=source_label,
            source_type=source_type,
            original_filename=safe_name,
            stored_path=None,
            mime_type=mime_type,
            sha256=sha256,
            ingest_method=ingest_method,
            status="ingesting",
            metadata={"conversation_format": conversation_format} if conversation_format else {},
        )

    destination = _storage_path(project_id, source_id, safe_name, storage_root)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)

    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE project_text_sources
            SET stored_path = $3,
                status = 'ingesting',
                updated_at = NOW()
            WHERE project_id = $1 AND id = $2
            """,
            project_id,
            source_id,
            str(destination),
        )
        await _delete_chunks_for_source(conn, project_id, source_id)

    chunk_count = await _ingest_source_content(
        pool,
        project_id=project_id,
        source_id=source_id,
        source_label=source_label,
        source_type=source_type,
        stored_path=destination,
        conversation_format=conversation_format,
    )

    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE project_text_sources
            SET status = 'indexed',
                updated_at = NOW()
            WHERE project_id = $1 AND id = $2
            """,
            project_id,
            source_id,
        )

    if is_global_scope(project_id):
        invalidate_bm25_cache("global_text_chunks", "source_key", project_id)
    else:
        invalidate_bm25_cache("text_chunks", "project_id", project_id)
    return {
        "status": "indexed",
        "source_id": source_id,
        "source_label": source_label,
        "chunk_count": chunk_count,
        "source_type": source_type,
    }


async def ingest_uploaded_files(
    pool: asyncpg.Pool,
    *,
    project_id: str,
    files: Iterable[tuple[str, bytes, str | None]],
    replace_existing: bool = False,
    dedupe_by_hash: bool = False,
    conversation_format: str | None = None,
    storage_root: Path = DEFAULT_UPLOAD_ROOT,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for filename, data, content_type in files:
        conversation = (conversation_format or "").lower() in {"json", "ndjson", "txt", "text", "md", "markdown"}
        try:
            result = await ingest_bytes_as_source(
                pool,
                project_id=project_id,
                filename=filename,
                data=data,
                ingest_method="web_upload",
                replace_existing=replace_existing,
                dedupe_by_hash=dedupe_by_hash,
                conversation=conversation or Path(filename).suffix.lower() in {".json", ".ndjson"},
                conversation_format=conversation_format,
                storage_root=storage_root,
            )
            result["mime_type"] = content_type
        except Exception as exc:
            result = {"status": "failed", "filename": filename, "error": str(exc), "mime_type": content_type}
        results.append(result)
    return results


async def ingest_local_file(
    pool: asyncpg.Pool,
    *,
    project_id: str,
    path: Path,
    source_label: str | None = None,
    ingest_method: str = "cli",
    conversation: bool = False,
    conversation_format: str | None = None,
    replace_existing: bool = False,
    dedupe_by_hash: bool = False,
    storage_root: Path = DEFAULT_UPLOAD_ROOT,
) -> dict[str, Any]:
    if not path.exists() or not path.is_file():
        raise ValueError(f"File not found: {path}")
    return await ingest_bytes_as_source(
        pool,
        project_id=project_id,
        filename=path.name,
        data=path.read_bytes(),
        source_label=source_label or path.stem,
        ingest_method=ingest_method,
        conversation=conversation,
        conversation_format=conversation_format,
        replace_existing=replace_existing,
        dedupe_by_hash=dedupe_by_hash,
        storage_root=storage_root,
    )


async def reingest_project_source(
    pool: asyncpg.Pool,
    *,
    project_id: str,
    source_id: str,
) -> dict[str, Any]:
    async with pool.acquire() as conn:
        row = await _fetch_source(conn, project_id, source_id)
        if not row:
            raise ValueError("Source not found")
        stored_path = row["stored_path"]
        if not stored_path:
            raise ValueError("Source has no stored file to reingest")
        await _delete_chunks_for_source(conn, project_id, source_id)
        await conn.execute(
            "UPDATE project_text_sources SET status = 'ingesting', updated_at = NOW() WHERE project_id = $1 AND id = $2",
            project_id,
            source_id,
        )
        metadata = row["metadata"] or {}
        conversation_format = metadata.get("conversation_format") if isinstance(metadata, dict) else None
        source_label = row["source_label"]
        source_type = row["source_type"]

    chunk_count = await _ingest_source_content(
        pool,
        project_id=project_id,
        source_id=source_id,
        source_label=source_label,
        source_type=source_type,
        stored_path=Path(stored_path),
        conversation_format=conversation_format,
    )

    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE project_text_sources SET status = 'indexed', updated_at = NOW() WHERE project_id = $1 AND id = $2",
            project_id,
            source_id,
        )
    invalidate_bm25_cache("text_chunks", "project_id", project_id)
    return {"status": "indexed", "source_id": source_id, "chunk_count": chunk_count}


async def replace_project_source(
    pool: asyncpg.Pool,
    *,
    project_id: str,
    source_id: str,
    filename: str,
    data: bytes,
    conversation_format: str | None = None,
    storage_root: Path = DEFAULT_UPLOAD_ROOT,
) -> dict[str, Any]:
    async with pool.acquire() as conn:
        row = await _fetch_source(conn, project_id, source_id)
        if not row:
            raise ValueError("Source not found")
        source_label = row["source_label"]
    return await ingest_bytes_as_source(
        pool,
        project_id=project_id,
        filename=filename,
        data=data,
        source_label=source_label,
        ingest_method="web_upload",
        conversation=row["source_type"] == "conversation_export",
        conversation_format=conversation_format,
        replace_existing=True,
        storage_root=storage_root,
    )
