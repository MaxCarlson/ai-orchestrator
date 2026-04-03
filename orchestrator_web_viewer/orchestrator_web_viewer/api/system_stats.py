"""System stats endpoints for docker + database."""
from __future__ import annotations

import os
import subprocess
from typing import Any, Dict, List

import asyncpg
import httpx
from fastapi import APIRouter, HTTPException


router = APIRouter()
_last_cpu_total: float | None = None
_last_cpu_idle: float | None = None


def _db_config() -> Dict[str, Any]:
    return {
        "host": os.getenv("KO_WEB_POSTGRES_HOST", os.getenv("POSTGRES_HOST", "localhost")),
        "port": int(os.getenv("KO_WEB_POSTGRES_PORT", os.getenv("POSTGRES_PORT", "5432"))),
        "user": os.getenv("KO_WEB_POSTGRES_USER", os.getenv("POSTGRES_USER", "km_user")),
        "password": os.getenv("KO_WEB_POSTGRES_PASSWORD", os.getenv("POSTGRES_PASSWORD", "")),
        "database": os.getenv("KO_WEB_POSTGRES_DB", os.getenv("POSTGRES_DB", "knowledge_manager")),
    }


def _read_cpu_times() -> tuple[float, float] | None:
    try:
        with open("/proc/stat", "r", encoding="utf-8") as handle:
            first = handle.readline()
        if not first.startswith("cpu "):
            return None
        parts = first.split()
        values = [float(value) for value in parts[1:]]
        if len(values) < 4:
            return None
        idle = values[3] + (values[4] if len(values) > 4 else 0.0)
        total = sum(values)
        return total, idle
    except Exception:
        return None


def _read_meminfo() -> tuple[int, int]:
    total_kb = 0
    available_kb = 0
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("MemTotal:"):
                    total_kb = int(line.split()[1])
                elif line.startswith("MemAvailable:"):
                    available_kb = int(line.split()[1])
    except Exception:
        return 0, 0
    used_kb = max(total_kb - available_kb, 0)
    return used_kb, total_kb


def _read_gpu_stats() -> list[dict]:
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=utilization.gpu,memory.used,memory.total",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
    except Exception:
        return []
    if result.returncode != 0 or not result.stdout.strip():
        return []
    rows = []
    for line in result.stdout.strip().splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 3:
            continue
        rows.append({
            "utilization": int(parts[0]) if parts[0].isdigit() else None,
            "mem_used_mb": int(parts[1]) if parts[1].isdigit() else None,
            "mem_total_mb": int(parts[2]) if parts[2].isdigit() else None,
        })
    return rows


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
        stats["text_chunks"] = await _safe_count(conn, "text_chunks")
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


def _table_group(table_name: str) -> str:
    if table_name.startswith("global_"):
        return "global"
    memory_tables = {
        "memory_items",
        "memory_categories",
        "categories",
        "code_chunks",
        "embedding_runs",
    }
    if table_name in memory_tables:
        return "memory"
    return "core"


def _table_label(table_name: str) -> str:
    return table_name.replace("_", " ").title()


@router.get("/db-schema")
async def db_schema():
    """Return database schema metadata for visualization."""
    cfg = _db_config()
    try:
        conn = await asyncpg.connect(**cfg)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Database connection failed: {exc}") from exc

    try:
        tables = await conn.fetch(
            """
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
            ORDER BY table_name
            """
        )
        fks = await conn.fetch(
            """
            SELECT
                tc.table_name AS table_name,
                ccu.table_name AS foreign_table_name
            FROM information_schema.table_constraints AS tc
            JOIN information_schema.constraint_column_usage AS ccu
                ON ccu.constraint_name = tc.constraint_name
                AND ccu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY'
              AND tc.table_schema = 'public'
            """
        )
    finally:
        await conn.close()

    table_rows = [row["table_name"] for row in tables]
    table_items = [
        {
            "name": name,
            "label": _table_label(name),
            "group": _table_group(name),
        }
        for name in table_rows
    ]

    edges = []
    for fk in fks:
        source = fk["table_name"]
        target = fk["foreign_table_name"]
        if source not in table_rows or target not in table_rows:
            continue
        group = _table_group(source)
        if _table_group(target) != group:
            continue
        edges.append({"from": source, "to": target, "group": group})

    return {
        "tables": table_items,
        "edges": edges,
        "groups": [
            {"id": "core", "label": "Core tables"},
            {"id": "memory", "label": "Memory tables"},
            {"id": "global", "label": "Global tables"},
        ],
    }


@router.get("/db-trends")
async def db_trends():
    """Return per-project counts for trend visualization."""
    cfg = _db_config()
    try:
        conn = await asyncpg.connect(**cfg)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Database connection failed: {exc}") from exc

    try:
        projects = await conn.fetch(
            "SELECT id, name FROM projects ORDER BY name"
        )
        tasks = await conn.fetch(
            "SELECT project_id, COUNT(*) AS count FROM tasks GROUP BY project_id"
        )
        memories = await conn.fetch(
            "SELECT project_id, COUNT(*) AS count FROM memory_items GROUP BY project_id"
        )
        code_chunks = []
        exists = await conn.fetchval("SELECT to_regclass('public.code_chunks')")
        if exists:
            code_chunks = await conn.fetch(
                "SELECT project_id, COUNT(*) AS count FROM code_chunks GROUP BY project_id"
            )
    finally:
        await conn.close()

    task_map = {str(row["project_id"]): row["count"] for row in tasks}
    memory_map = {str(row["project_id"]): row["count"] for row in memories}
    chunk_map = {str(row["project_id"]): row["count"] for row in code_chunks}

    results = []
    for row in projects:
        project_id = str(row["id"])
        results.append({
            "id": project_id,
            "name": row["name"],
            "tasks": int(task_map.get(project_id, 0) or 0),
            "memories": int(memory_map.get(project_id, 0) or 0),
            "code_chunks": int(chunk_map.get(project_id, 0) or 0),
        })

    return {"projects": results}


@router.get("/telemetry")
async def telemetry():
    """Return lightweight CPU/RAM/GPU telemetry for the system meter."""
    global _last_cpu_total, _last_cpu_idle
    cpu_percent = None
    current = _read_cpu_times()
    if current:
        total, idle = current
        if _last_cpu_total is not None and _last_cpu_idle is not None:
            delta_total = total - _last_cpu_total
            delta_idle = idle - _last_cpu_idle
            if delta_total > 0:
                cpu_percent = (1.0 - (delta_idle / delta_total)) * 100.0
        _last_cpu_total = total
        _last_cpu_idle = idle

    mem_used_kb, mem_total_kb = _read_meminfo()
    mem_used_mb = int(mem_used_kb / 1024) if mem_used_kb else 0
    mem_total_mb = int(mem_total_kb / 1024) if mem_total_kb else 0

    return {
        "cpu_percent": cpu_percent,
        "mem_used_mb": mem_used_mb,
        "mem_total_mb": mem_total_mb,
        "gpu": _read_gpu_stats(),
    }
