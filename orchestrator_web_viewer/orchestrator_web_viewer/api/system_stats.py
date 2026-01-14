"""System stats endpoints for docker + database."""
from __future__ import annotations

import os
from typing import Any, Dict, List

import asyncpg
import httpx
from fastapi import APIRouter, HTTPException


router = APIRouter()


def _db_config() -> Dict[str, Any]:
    return {
        "host": os.getenv("KO_WEB_POSTGRES_HOST", os.getenv("POSTGRES_HOST", "localhost")),
        "port": int(os.getenv("KO_WEB_POSTGRES_PORT", os.getenv("POSTGRES_PORT", "5432"))),
        "user": os.getenv("KO_WEB_POSTGRES_USER", os.getenv("POSTGRES_USER", "km_user")),
        "password": os.getenv("KO_WEB_POSTGRES_PASSWORD", os.getenv("POSTGRES_PASSWORD", "")),
        "database": os.getenv("KO_WEB_POSTGRES_DB", os.getenv("POSTGRES_DB", "knowledge_manager")),
    }


async def _fetch_db_stats() -> Dict[str, Any]:
    cfg = _db_config()
    try:
        conn = await asyncpg.connect(**cfg)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Database connection failed: {exc}") from exc

    try:
        stats = {}
        stats["projects"] = await conn.fetchval("SELECT COUNT(*) FROM projects")
        stats["tasks"] = await conn.fetchval("SELECT COUNT(*) FROM tasks")
        stats["task_links"] = await _safe_count(conn, "task_links")
        stats["memory_items"] = await _safe_count(conn, "memory_items")
        stats["code_chunks"] = await _safe_count(conn, "code_chunks")
        stats["project_tracking"] = await _safe_count(conn, "project_tracking")
        stats["db_version"] = await conn.fetchval("SELECT version()")
        stats["db_size_bytes"] = await conn.fetchval("SELECT pg_database_size(current_database())")
        return stats
    finally:
        await conn.close()


def _format_ports(port_data: Any) -> List[str]:
    if not port_data:
        return []
    ports = []
    for container_port, mappings in port_data.items():
        if not mappings:
            continue
        for mapping in mappings:
            host = mapping.get("HostIp") or "0.0.0.0"
            host_port = mapping.get("HostPort")
            if host_port:
                ports.append(f"{host}:{host_port}->{container_port}")
    return ports


async def _safe_count(conn: asyncpg.Connection, table_name: str) -> int:
    exists = await conn.fetchval("SELECT to_regclass($1)", f"public.{table_name}")
    if not exists:
        return 0
    return await conn.fetchval(f"SELECT COUNT(*) FROM {table_name}")


@router.get("/docker")
async def docker_overview():
    """Return docker container info and basic runtime stats."""
    try:
        import docker  # type: ignore
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Docker SDK unavailable: {exc}") from exc

    try:
        client = docker.DockerClient(base_url="unix:///var/run/docker.sock")
        containers = client.containers.list(all=True)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Docker socket unavailable: {exc}") from exc

    data = []
    for container in containers:
        info = container.attrs or {}
        ports = _format_ports(info.get("NetworkSettings", {}).get("Ports"))
        row = {
            "id": container.id[:12],
            "name": container.name,
            "status": container.status,
            "image": (container.image.tags or ["<none>"])[0],
            "ports": ports,
        }
        if container.status == "running":
            try:
                stats = container.stats(stream=False)
                mem = stats.get("memory_stats", {})
                row["mem_usage_bytes"] = mem.get("usage")
                row["mem_limit_bytes"] = mem.get("limit")
            except Exception:
                row["mem_usage_bytes"] = None
                row["mem_limit_bytes"] = None
        data.append(row)

    return {"containers": data}


@router.get("/db")
async def db_stats():
    """Return basic database statistics."""
    return await _fetch_db_stats()


@router.get("/lmstudio")
async def lmstudio_status():
    """Return LM Studio server status and models."""
    host = os.getenv("KO_WEB_LMSTUDIO_HOST", "host.docker.internal")
    port = int(os.getenv("KO_WEB_LMSTUDIO_PORT", "1234"))
    base = f"http://{host}:{port}"

    result: Dict[str, Any] = {"host": host, "port": port, "server": "unknown"}
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            health = await client.get(f"{base}/v1/health")
            if health.status_code == 200:
                result["server"] = "online"
            models = await client.get(f"{base}/v1/models")
            if models.status_code == 200:
                data = models.json()
                result["models"] = data.get("data", [])
            else:
                result["models_error"] = models.text
    except Exception as exc:
        result["server"] = "offline"
        result["error"] = str(exc)

    return result


@router.get("/lmstudio-bridge/health")
async def lmstudio_bridge_health():
    """Check LM Studio bridge health."""
    url = os.getenv("KO_WEB_LMS_BRIDGE_URL", "http://host.docker.internal:5080")
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.get(f"{url}/health")
    return resp.json()


@router.get("/db-queries")
async def db_queries():
    """Return default database query results."""
    cfg = _db_config()
    try:
        conn = await asyncpg.connect(**cfg)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Database connection failed: {exc}") from exc

    try:
        projects = await conn.fetch(
            """
            SELECT id, name, status, created_at
            FROM projects
            ORDER BY created_at DESC
            LIMIT 10
            """
        )
        tasks = await conn.fetch(
            """
            SELECT id, title, status, created_at
            FROM tasks
            ORDER BY created_at DESC
            LIMIT 10
            """
        )
        memories = await conn.fetch(
            """
            SELECT memory_id, created_by, created_at
            FROM memory_items
            ORDER BY created_at DESC
            LIMIT 10
            """
        )
        code_chunks = []
        exists = await conn.fetchval("SELECT to_regclass('public.code_chunks')")
        if exists:
            code_chunks = await conn.fetch(
                """
                SELECT file_path, symbol_name, updated_at
                FROM code_chunks
                ORDER BY updated_at DESC
                LIMIT 10
                """
            )
    finally:
        await conn.close()

    def _normalize(rows):
        return [dict(row) for row in rows]

    return {
        "projects": _normalize(projects),
        "tasks": _normalize(tasks),
        "memories": _normalize(memories),
        "code_chunks": _normalize(code_chunks),
    }
