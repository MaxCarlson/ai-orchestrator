#!/usr/bin/env python3
"""S0 evidence collector. Live indexing uses a disposable, labelled PostgreSQL container."""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
from importlib.metadata import PackageNotFoundError, version
import json
import os
import platform
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
CHECK_IDS = ("S0-PREFLIGHT", "S0-CODE-DIRECT", "S0-TEXT", "S0-CODE-SEARCH", "S0-TEXT-SEARCH", "S0-REINDEX", "S0-WORKER", "S0-WORKER-RESTART", "S0-MODEL", "S0-CHAT", "S0-HISTORY", "S0-ROUTES")
MAX_LOG = 12_000


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def redact(value: str, secrets_to_hide: tuple[str, ...] = ()) -> str:
    for secret in secrets_to_hide:
        if secret:
            value = value.replace(secret, "[REDACTED]")
    value = re.sub(r"(?i)(password|token|api[_-]?key|secret)(\s*[=:]\s*)[^\s&]+", r"\1\2[REDACTED]", value)
    value = re.sub(r"(?i)(postgres(?:ql)?://[^\s:/@]+:)[^@\s]+@", r"\1[REDACTED]@", value)
    return value[:MAX_LOG]


def run_command(argv: list[str], *, timeout: int, env: dict[str, str] | None = None, secret: str = "") -> dict[str, Any]:
    started = time.monotonic()
    safe_argv = [redact(arg, (secret,)) for arg in argv]
    try:
        result = subprocess.run(argv, cwd=ROOT, env=env, capture_output=True, text=True, errors="replace", timeout=timeout, check=False)
        return {"argv": safe_argv, "exit_code": result.returncode, "elapsed_seconds": round(time.monotonic() - started, 3), "log": redact(result.stdout + "\n" + result.stderr, (secret,))}
    except (OSError, subprocess.TimeoutExpired) as exc:
        output = getattr(exc, "stdout", None) or b""
        if isinstance(output, bytes):
            output = output.decode("utf-8", errors="replace")
        return {"argv": safe_argv, "exit_code": None, "elapsed_seconds": round(time.monotonic() - started, 3), "log": redact(f"{type(exc).__name__}: {exc}\n{output}", (secret,))}


def run_command_with_heartbeat(
    argv: list[str],
    *,
    timeout: int,
    label: str,
    env: dict[str, str] | None = None,
    secret: str = "",
    interval: float = 5,
) -> dict[str, Any]:
    """Run a bounded command while periodically showing that it is still active."""
    started = time.monotonic()
    stopped = threading.Event()

    def emit_heartbeat() -> None:
        while not stopped.wait(interval):
            elapsed = int(time.monotonic() - started)
            print(f"[s0] {label} still running (elapsed: {elapsed}s)...", file=sys.stderr, flush=True)

    heartbeat = threading.Thread(target=emit_heartbeat, daemon=True)
    heartbeat.start()
    try:
        return run_command(argv, timeout=timeout, env=env, secret=secret)
    finally:
        stopped.set()
        heartbeat.join()


def find_free_port() -> int:
    """Acquire an ephemeral port bound to loopback."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def http_request_with_heartbeat(
    url: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    timeout: float = 30.0,
    label: str = "HTTP request",
    interval: float = 5.0,
) -> dict[str, Any]:
    """Execute an HTTP request while periodically emitting heartbeats if slow."""
    started = time.monotonic()
    stopped = threading.Event()

    def emit_heartbeat() -> None:
        while not stopped.wait(interval):
            elapsed = int(time.monotonic() - started)
            print(f"[s0] {label} still running (elapsed: {elapsed}s)...", file=sys.stderr, flush=True)

    heartbeat = threading.Thread(target=emit_heartbeat, daemon=True)
    heartbeat.start()
    try:
        data_bytes = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Content-Type": "application/json"} if payload is not None else {}
        req = urllib.request.Request(url, data=data_bytes, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            elapsed_sec = round(time.monotonic() - started, 3)
            raw = resp.read().decode("utf-8")
            body = json.loads(raw) if raw else None
            return {
                "status_code": resp.status,
                "elapsed_seconds": elapsed_sec,
                "body": body,
                "error": None,
            }
    except urllib.error.HTTPError as exc:
        elapsed_sec = round(time.monotonic() - started, 3)
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            body = json.loads(raw)
        except Exception:
            body = raw
        return {
            "status_code": exc.code,
            "elapsed_seconds": elapsed_sec,
            "body": body,
            "error": f"HTTPError {exc.code}: {exc.reason}",
        }
    except Exception as exc:
        elapsed_sec = round(time.monotonic() - started, 3)
        return {
            "status_code": None,
            "elapsed_seconds": elapsed_sec,
            "body": None,
            "error": f"{type(exc).__name__}: {exc}",
        }
    finally:
        stopped.set()
        heartbeat.join()


def wait_for_api_readiness(api_port: int, api_proc: subprocess.Popen, timeout: int) -> tuple[bool, bool, str]:
    """Poll API /health until healthy or timeout/premature exit occurs. Returns (ready, exited, detail)."""
    started = time.monotonic()
    last_heartbeat = started
    deadline = started + timeout
    while time.monotonic() < deadline:
        elapsed = int(time.monotonic() - started)
        if api_proc.poll() is not None:
            return False, True, f"API process exited prematurely with exit code {api_proc.returncode}."
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{api_port}/health")
            with urllib.request.urlopen(req, timeout=min(2, timeout)) as resp:
                if resp.status == 200:
                    raw = resp.read().decode("utf-8")
                    body = json.loads(raw) if raw else {}
                    if body.get("status") == "healthy":
                        return True, False, "API process is healthy."
        except Exception:
            pass

        if time.monotonic() - last_heartbeat >= 5:
            print(f"[s0] Waiting for API readiness at 127.0.0.1:{api_port} (elapsed: {elapsed}s / timeout: {timeout}s)...", file=sys.stderr, flush=True)
            last_heartbeat = time.monotonic()

        time.sleep(0.5)

    return False, False, f"API process at 127.0.0.1:{api_port} did not become healthy within timeout ({timeout}s)."


def execute_search_validation(
    api_port: int,
    project_id: str,
    *,
    password: str = "",
    timeout: int = 30,
) -> dict[str, dict[str, Any]]:
    """Query code and text search endpoints, asserting fixture results and project scope."""
    checks: dict[str, dict[str, Any]] = {}
    decoy_id = str(uuid.uuid4())

    # --- Code Search Check ---
    print("[s0] Executing code search validation...", file=sys.stderr, flush=True)
    code_url = f"http://127.0.0.1:{api_port}/memory/code-search/{project_id}"
    code_payload = {"query": "s0_nebula_probe", "top_k": 8}
    code_res = http_request_with_heartbeat(
        code_url,
        method="POST",
        payload=code_payload,
        timeout=timeout,
        label="Code search query",
    )

    decoy_code_url = f"http://127.0.0.1:{api_port}/memory/code-search/{decoy_id}"
    decoy_code_res = http_request_with_heartbeat(
        decoy_code_url,
        method="POST",
        payload=code_payload,
        timeout=timeout,
        label="Decoy code search query",
    )

    code_body = code_res.get("body")
    code_status = "FAIL"
    code_detail = ""
    matching_code_chunks = []

    if code_res.get("status_code") != 200:
        code_detail = f"Code search endpoint returned HTTP {code_res.get('status_code')}: {code_res.get('error')}"
    elif not isinstance(code_body, list):
        code_detail = "Code search endpoint returned non-list response."
    else:
        for item in code_body:
            if isinstance(item, dict) and item.get("symbol_name") == "s0_nebula_probe" and "probe.py" in str(item.get("file_path", "")):
                matching_code_chunks.append({
                    "symbol_name": item.get("symbol_name"),
                    "file_path": item.get("file_path"),
                    "start_line": item.get("start_line"),
                    "end_line": item.get("end_line"),
                    "similarity": item.get("similarity"),
                    "rrf_score": item.get("rrf_score"),
                })
        decoy_body = decoy_code_res.get("body")
        if not matching_code_chunks:
            code_detail = f"Code search endpoint returned {len(code_body)} results but did not include 's0_nebula_probe' in probe.py."
        elif decoy_code_res.get("status_code") != 200:
            code_detail = f"Decoy code search failed with HTTP {decoy_code_res.get('status_code')}."
        elif not isinstance(decoy_body, list) or len(decoy_body) != 0:
            count = len(decoy_body) if isinstance(decoy_body, list) else "unknown"
            code_detail = f"Code search failed project isolation: decoy project query returned {count} results."
        else:
            code_status = "PASS"
            code_detail = "Code search returned fixture symbol 's0_nebula_probe' in probe.py and enforced project isolation."

    checks["S0-CODE-SEARCH"] = result(
        code_status,
        code_detail,
        url=code_url,
        request_payload=code_payload,
        status_code=code_res.get("status_code"),
        elapsed_seconds=code_res.get("elapsed_seconds"),
        results_count=len(code_body) if isinstance(code_body, list) else None,
        matching_chunks=matching_code_chunks,
        decoy_test={
            "decoy_project_id": decoy_id,
            "status_code": decoy_code_res.get("status_code"),
            "results_count": len(decoy_code_res.get("body")) if isinstance(decoy_code_res.get("body"), list) else None,
        },
        project_id=project_id,
    )

    # --- Text Search Check ---
    print("[s0] Executing text search validation...", file=sys.stderr, flush=True)
    text_url = f"http://127.0.0.1:{api_port}/memory/text-search/{project_id}"
    text_payload = {"query": "S0 nebula violet", "top_k": 10, "use_reranker": False}
    text_res = http_request_with_heartbeat(
        text_url,
        method="POST",
        payload=text_payload,
        timeout=timeout,
        label="Text search query",
    )

    decoy_text_url = f"http://127.0.0.1:{api_port}/memory/text-search/{decoy_id}"
    decoy_text_res = http_request_with_heartbeat(
        decoy_text_url,
        method="POST",
        payload=text_payload,
        timeout=timeout,
        label="Decoy text search query",
    )

    text_body = text_res.get("body")
    text_status = "FAIL"
    text_detail = ""
    matching_text_chunks = []

    if text_res.get("status_code") != 200:
        text_detail = f"Text search endpoint returned HTTP {text_res.get('status_code')}: {text_res.get('error')}"
    elif not isinstance(text_body, dict):
        text_detail = "Text search endpoint returned non-dict response."
    else:
        results_list = text_body.get("results")
        if not isinstance(results_list, list):
            text_detail = "Text search endpoint response missing 'results' list."
        else:
            for item in results_list:
                if isinstance(item, dict) and "readme.md" in str(item.get("file_path", "")) and "S0 nebula violet" in str(item.get("content", "")):
                    matching_text_chunks.append({
                        "file_path": item.get("file_path"),
                        "content": redact(item.get("content", "")[:200], (password,)),
                        "similarity": item.get("similarity"),
                        "rrf_score": item.get("rrf_score"),
                    })
            decoy_body = decoy_text_res.get("body")
            decoy_results = decoy_body.get("results") if isinstance(decoy_body, dict) else None
            decoy_count = decoy_body.get("count", len(decoy_results) if isinstance(decoy_results, list) else None) if isinstance(decoy_body, dict) else None
            if not matching_text_chunks:
                text_detail = f"Text search endpoint returned {len(results_list)} results but did not include fixture fact in readme.md."
            elif decoy_text_res.get("status_code") != 200:
                text_detail = f"Decoy text search failed with HTTP {decoy_text_res.get('status_code')}."
            elif not isinstance(decoy_results, list) or len(decoy_results) != 0:
                text_detail = f"Text search failed project isolation: decoy project query returned {decoy_count} results."
            else:
                text_status = "PASS"
                text_detail = "Text search returned fixture fact in readme.md and enforced project isolation."

    checks["S0-TEXT-SEARCH"] = result(
        text_status,
        text_detail,
        url=text_url,
        request_payload=text_payload,
        status_code=text_res.get("status_code"),
        elapsed_seconds=text_res.get("elapsed_seconds"),
        results_count=text_body.get("count") if isinstance(text_body, dict) else None,
        matching_chunks=matching_text_chunks,
        decoy_test={
            "decoy_project_id": decoy_id,
            "status_code": decoy_text_res.get("status_code"),
            "results_count": decoy_count,
        },
        project_id=project_id,
    )

    return checks


def result(status: str, detail: str, **evidence: Any) -> dict[str, Any]:
    return {"status": status, "detail": detail, "evidence": evidence}


def model_unavailable(output: str) -> bool:
    """Classify an offline cache miss as an environment block, not a product defect."""
    lowered = output.lower()
    return any(marker in lowered for marker in ("localentrynotfounderror", "not found in the cached files", "not cached", "offline mode", "hf_hub_offline", "outgoing traffic has been disabled", "couldn't connect"))


def exit_code(checks: dict[str, dict[str, Any]], selected: set[str]) -> int:
    statuses = [checks[name]["status"] for name in selected]
    if "FAIL" in statuses:
        return 1
    if "BLOCKED" in statuses or "NOT_RUN" in statuses:
        return 2
    return 0


def atomic_report(report: dict[str, Any], directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    lines = ["# S0 validation report", "", f"Run: `{report['run_id']}`  ", f"Commit: `{report['git']['commit']}`  ", f"Started: `{report['started_at']}`  ", f"Finished: `{report['finished_at']}`", "", "| Check | Status | Detail |", "| --- | --- | --- |"]
    for name, item in report["checks"].items():
        detail = item["detail"].replace("|", "\\|").replace("\n", " ")
        lines.append(f"| {name} | {item['status']} | {detail} |")
    for name, item in report["checks"].items():
        lines.extend(("", f"## {name}", "", "```json", json.dumps(item["evidence"], indent=2, ensure_ascii=False), "```"))
    for filename, content in (("report.json", json.dumps(report, indent=2, ensure_ascii=False) + "\n"), ("report.md", "\n".join(lines) + "\n")):
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory, prefix=".s0-", delete=False) as handle:
            tmp = Path(handle.name)
            handle.write(content)
        os.chmod(tmp, 0o600)
        tmp.replace(directory / filename)


def git_metadata() -> dict[str, Any]:
    def git(*args: str) -> str:
        result_ = run_command(["git", *args], timeout=5)
        return result_["log"].strip() if result_["exit_code"] == 0 else "unavailable"

    return {"branch": git("branch", "--show-current"), "commit": git("rev-parse", "HEAD"), "dirty": bool(git("status", "--porcelain"))}


def preflight(timeout: int) -> dict[str, Any]:
    dependencies = {name: importlib.util.find_spec(name) is not None for name in ("asyncpg", "sentence_transformers", "langchain_core", "langchain_community")}
    package_versions = {}
    for package in ("asyncpg", "sentence-transformers", "langchain-core", "langchain-community"):
        try:
            package_versions[package] = version(package)
        except PackageNotFoundError:
            package_versions[package] = None
    docker = run_command(["docker", "info", "--format", "{{.ServerVersion}}"], timeout=timeout)
    image = run_command(["docker", "image", "inspect", "pgvector/pgvector:pg16", "--format", "{{.Id}}"], timeout=timeout) if docker["exit_code"] == 0 else None
    evidence = {"python": platform.python_version(), "platform": platform.platform(), "dependencies": dependencies, "package_versions": package_versions, "docker": docker, "image": image, "index_entrypoint": "python -m memory.run_embeddings", "image_pull": "disabled", "model_download": "disabled"}
    if not all(dependencies.values()):
        return result("BLOCKED", "Python dependencies missing; install the repository's declared dependencies in the project environment.", **evidence)
    if docker["exit_code"] != 0:
        return result("BLOCKED", "Docker daemon unavailable; the isolated database cannot start.", **evidence)
    if image is None or image["exit_code"] != 0:
        return result("BLOCKED", "pgvector/pgvector:pg16 is not present locally. Fetch it explicitly before a live run.", **evidence)
    return result("PASS", "Local prerequisites found; this does not establish database/model readiness.", **evidence)


async def inspect_index(host: str, port: int, password: str, project_id: str) -> dict[str, Any]:
    import asyncpg

    conn = await asyncpg.connect(host=host, port=port, user="s0_user", password=password, database="s0_db", timeout=8)
    try:
        code_rows = await conn.fetch("SELECT symbol_name, file_path, start_line, end_line, embedding_model, vector_dims(embedding) AS dims FROM code_chunks WHERE project_id = $1::uuid ORDER BY symbol_name", project_id)
        text_rows = await conn.fetch("SELECT file_path, content FROM text_chunks WHERE project_id = $1::uuid ORDER BY file_path", project_id)
        code = [dict(row) for row in code_rows]
        docs = [{"file_path": row["file_path"], "contains_nonce": "S0 nebula violet" in row["content"]} for row in text_rows]
        version = await conn.fetchval("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
        tracking_row = await conn.fetchrow(
            "SELECT embedding_status, embedding_model_id, text_embedding_model_id FROM project_tracking WHERE project_id = $1::uuid",
            project_id,
        )
        return {
            "code": code[:30],
            "code_count": len(code),
            "text": docs[:30],
            "text_count": len(docs),
            "pgvector": version,
            "project_tracking": dict(tracking_row) if tracking_row else None,
        }
    finally:
        await conn.close()


def stage_init_scripts(src: Path, dst: Path) -> Path:
    """Copy PostgreSQL init scripts to workspace and ensure world-readable permissions."""
    shutil.copytree(src, dst, dirs_exist_ok=True)
    for path in dst.rglob("*"):
        if path.is_file():
            path.chmod(0o644)
        elif path.is_dir():
            path.chmod(0o755)
    return dst


def get_container_diagnostics(container: str, *, timeout: int = 10, password: str = "") -> dict[str, Any]:
    """Capture safe container inspect state and bounded, redacted logs before cleanup."""
    logs_res = run_command(["docker", "logs", container], timeout=min(timeout, 10), secret=password)
    inspect_res = run_command(["docker", "inspect", "--format", "{{json .State}}", container], timeout=min(timeout, 5))
    safe_state: dict[str, Any] = {}
    if inspect_res["exit_code"] == 0:
        try:
            raw = json.loads(inspect_res["log"].strip())
            safe_state = {k: raw[k] for k in ("Status", "Running", "Paused", "Restarting", "ExitCode", "Error", "StartedAt", "FinishedAt") if k in raw}
        except Exception:
            safe_state = {"raw": inspect_res["log"].strip()}
    raw_logs = logs_res.get("log") or ""
    redacted_logs = redact(raw_logs, (password,)) if password else raw_logs
    return {
        "container_logs": redacted_logs[-MAX_LOG:] if redacted_logs else "No container logs captured.",
        "container_state": safe_state,
    }


def isolated_indexing(timeout: int, run_id: str, code_model: str, text_model: str) -> dict[str, dict[str, Any]]:
    """Start only a uniquely labelled container, and index a newly created fixture."""
    checks: dict[str, dict[str, Any]] = {}
    container = f"aioc-s0-{run_id[:12]}"
    marker = f"ai-orchestrator-s0={run_id}"
    password = secrets.token_urlsafe(32)
    project_id = str(uuid.uuid4())
    container_started = False
    api_proc: subprocess.Popen | None = None
    api_log_file: Any = None
    with tempfile.TemporaryDirectory(prefix="aioc-s0-") as workspace:
        fixture = Path(workspace) / "fixture"
        fixture.mkdir()
        (fixture / "probe.py").write_text("def s0_nebula_probe():\n    return 'S0 nebula violet'\n", encoding="utf-8")
        (fixture / "readme.md").write_text("S0 nebula violet is the indexed fixture fact.\n", encoding="utf-8")
        init_scripts_dir = stage_init_scripts(ROOT / "docker/postgres/init-scripts", Path(workspace) / "init-scripts")
        env_file = Path(workspace) / "postgres.env"
        env_file.write_text(f"POSTGRES_USER=s0_user\nPOSTGRES_PASSWORD={password}\nPOSTGRES_DB=s0_db\n", encoding="utf-8")
        os.chmod(env_file, 0o600)
        try:
            start = run_command(["docker", "run", "--detach", "--pull=never", "--name", container, "--label", marker, "--publish", "127.0.0.1::5432", "--env-file", str(env_file), "--mount", f"type=bind,src={init_scripts_dir},dst=/docker-entrypoint-initdb.d,readonly", "pgvector/pgvector:pg16"], timeout=timeout, secret=password)
            if start["exit_code"] != 0:
                return {name: result("BLOCKED", "Unable to start run-owned disposable database.", command=start) for name in ("S0-CODE-DIRECT", "S0-TEXT", "S0-CODE-SEARCH", "S0-TEXT-SEARCH", "S0-REINDEX")}
            container_started = True
            port_result = run_command(["docker", "port", container, "5432/tcp"], timeout=timeout)
            match = re.search(r"127\.0\.0\.1:(\d+)", port_result["log"])
            if not match:
                diagnostics = get_container_diagnostics(container, timeout=timeout, password=password)
                return {name: result("BLOCKED", "No loopback Docker port published.", command=port_result, **diagnostics) for name in ("S0-CODE-DIRECT", "S0-TEXT", "S0-CODE-SEARCH", "S0-TEXT-SEARCH", "S0-REINDEX")}
            port = int(match.group(1))
            ready = False
            container_exited = False
            started_wait = time.monotonic()
            last_heartbeat = started_wait
            deadline = started_wait + timeout
            while time.monotonic() < deadline:
                elapsed = int(time.monotonic() - started_wait)
                inspect_check = run_command(["docker", "inspect", "--format", "{{json .State}}", container], timeout=min(5, timeout))
                if inspect_check["exit_code"] == 0:
                    try:
                        state_obj = json.loads(inspect_check["log"].strip())
                        if not state_obj.get("Running", True) or state_obj.get("Status") in ("exited", "dead"):
                            container_exited = True
                            print(f"[s0] Disposable database container exited prematurely (status={state_obj.get('Status')}, exit_code={state_obj.get('ExitCode')})", file=sys.stderr, flush=True)
                            break
                    except Exception:
                        pass
                elif "No such container" in inspect_check["log"]:
                    container_exited = True
                    break

                check = run_command(["docker", "exec", container, "pg_isready", "-h", "127.0.0.1", "-p", "5432", "-U", "s0_user", "-d", "s0_db"], timeout=min(5, timeout))
                if check["exit_code"] == 0:
                    ready = True
                    break

                if time.monotonic() - last_heartbeat >= 5:
                    print(f"[s0] Waiting for disposable database readiness (elapsed: {elapsed}s / timeout: {timeout}s)...", file=sys.stderr, flush=True)
                    last_heartbeat = time.monotonic()

                time.sleep(1)

            if not ready:
                diagnostics = get_container_diagnostics(container, timeout=timeout, password=password)
                detail = "Disposable database container exited prematurely during initialization." if container_exited else "Disposable database did not become ready within timeout."
                return {name: result("BLOCKED", detail, command=start, **diagnostics) for name in ("S0-CODE-DIRECT", "S0-TEXT", "S0-CODE-SEARCH", "S0-TEXT-SEARCH", "S0-REINDEX")}

            env = os.environ.copy()
            env.update({"POSTGRES_PASSWORD": password, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1", "PYTHONPATH": str(ROOT)})
            insert = run_command(["docker", "exec", container, "psql", "-U", "s0_user", "-d", "s0_db", "-v", "ON_ERROR_STOP=1", "-c", f"INSERT INTO projects(id, name) VALUES ('{project_id}', 'S0 fixture {run_id}'); INSERT INTO project_tracking(project_id) VALUES ('{project_id}');"], timeout=timeout)
            if insert["exit_code"] != 0:
                diagnostics = get_container_diagnostics(container, timeout=timeout, password=password)
                return {name: result("FAIL", "Project registration failed in disposable database.", command=insert, **diagnostics) for name in ("S0-CODE-DIRECT", "S0-TEXT", "S0-CODE-SEARCH", "S0-TEXT-SEARCH", "S0-REINDEX")}
            common = [sys.executable, "-m", "memory.run_embeddings", "--repo-path", str(fixture), "--project-id", project_id, "--target", "project", "--db-host", "127.0.0.1", "--db-port", str(port), "--db-name", "s0_db", "--db-user", "s0_user", "--code-model", code_model, "--text-model", text_model, "--no-include-pdfs"]
            print("[s0] Starting code embedding check...", file=sys.stderr, flush=True)
            first = run_command_with_heartbeat(
                [*common, "--mode", "code"],
                timeout=timeout,
                env=env,
                secret=password,
                label="Code embedding/indexing",
            )
            if first["exit_code"] != 0:
                blocked = model_unavailable(first["log"])
                checks["S0-CODE-DIRECT"] = result("BLOCKED" if blocked else "FAIL", "Code model unavailable in the offline cache." if blocked else "Real code indexing failed in disposable database.", command=first)
            else:
                snapshot = asyncio.run(inspect_index("127.0.0.1", port, password, project_id))
                tracking = snapshot.get("project_tracking") or {}
                correct = (
                    any(row["symbol_name"] == "s0_nebula_probe" and row["dims"] == 768 and row["start_line"] == 1 for row in snapshot["code"])
                    and tracking.get("embedding_status") == "ready"
                    and tracking.get("embedding_model_id") == code_model
                )
                checks["S0-CODE-DIRECT"] = result("PASS" if correct else "FAIL", "Code symbol, vector row and tracking state verified." if correct else "Indexer did not create the expected 768D code row and update project tracking.", command=first, snapshot=snapshot, project_id=project_id)
            print("[s0] Starting text embedding check...", file=sys.stderr, flush=True)
            text = run_command_with_heartbeat(
                [*common, "--mode", "text"],
                timeout=timeout,
                env=env,
                secret=password,
                label="Text embedding/indexing",
            )
            if text["exit_code"] != 0:
                blocked = model_unavailable(text["log"])
                checks["S0-TEXT"] = result("BLOCKED" if blocked else "FAIL", "Text model unavailable in the offline cache." if blocked else "Real text indexing failed in disposable database.", command=text)
            else:
                snapshot = asyncio.run(inspect_index("127.0.0.1", port, password, project_id))
                tracking = snapshot.get("project_tracking") or {}
                correct = (
                    any(row["contains_nonce"] and row["file_path"].endswith("readme.md") for row in snapshot["text"])
                    and tracking.get("embedding_status") == "ready"
                    and tracking.get("text_embedding_model_id") == text_model
                )
                checks["S0-TEXT"] = result("PASS" if correct else "FAIL", "Document fact, source and tracking state verified." if correct else "Text indexer did not return the expected fact and update project tracking.", command=text, snapshot=snapshot)

            if checks.get("S0-CODE-DIRECT", {}).get("status") != "PASS" or checks.get("S0-TEXT", {}).get("status") != "PASS":
                checks["S0-CODE-SEARCH"] = result("BLOCKED", "Direct indexing did not pass; search endpoint check skipped.")
                checks["S0-TEXT-SEARCH"] = result("BLOCKED", "Direct indexing did not pass; search endpoint check skipped.")
                checks["S0-REINDEX"] = result("NOT_RUN", "Reindex/edit/delete checks follow search validation.")
                return checks

            # Direct indexing passed. Launch isolated API process and validate search endpoints.
            api_port = find_free_port()
            api_log_path = Path(workspace) / "orchestrator_api.log"
            api_log_file = open(api_log_path, "w", encoding="utf-8")
            api_env = os.environ.copy()
            api_env.update({
                "POSTGRES_HOST": "127.0.0.1",
                "POSTGRES_PORT": str(port),
                "POSTGRES_USER": "s0_user",
                "POSTGRES_PASSWORD": password,
                "POSTGRES_DB": "s0_db",
                "HOST_POSTGRES_HOST": "127.0.0.1",
                "HOST_POSTGRES_PORT": str(port),
                "HOST_REPO_ROOT": str(ROOT),
                "TASK_QUEUE_PATH": str(Path(workspace) / "task_queue"),
                "LOG_LEVEL": "INFO",
                "HF_HUB_OFFLINE": "1",
                "TRANSFORMERS_OFFLINE": "1",
                "HF_DATASETS_OFFLINE": "1",
                "PYTHONPATH": f"{ROOT}:{ROOT}/docker/orchestrator:{os.environ.get('PYTHONPATH', '')}",
            })
            api_cmd = [
                sys.executable,
                "-m",
                "uvicorn",
                "--app-dir",
                str(ROOT / "docker/orchestrator"),
                "main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(api_port),
                "--log-level",
                "info",
            ]
            print(f"[s0] Starting isolated API process at 127.0.0.1:{api_port}...", file=sys.stderr, flush=True)
            api_proc = subprocess.Popen(
                api_cmd,
                cwd=ROOT,
                env=api_env,
                stdout=api_log_file,
                stderr=subprocess.STDOUT,
            )

            api_ready, api_exited, api_detail = wait_for_api_readiness(api_port, api_proc, timeout=min(timeout, 30))
            if not api_ready:
                api_log_file.flush()
                api_logs = api_log_path.read_text(encoding="utf-8", errors="replace") if api_log_path.is_file() else ""
                redacted_api_logs = redact(api_logs, (password,))[-MAX_LOG:]
                api_evidence = {
                    "api_logs": redacted_api_logs,
                    "api_port": api_port,
                    "exit_code": api_proc.returncode if api_exited else None,
                }
                checks["S0-CODE-SEARCH"] = result("FAIL" if api_exited else "BLOCKED", api_detail, **api_evidence)
                checks["S0-TEXT-SEARCH"] = result("FAIL" if api_exited else "BLOCKED", api_detail, **api_evidence)
                checks["S0-REINDEX"] = result("NOT_RUN", "Reindex/edit/delete checks follow search validation.")
                return checks

            search_checks = execute_search_validation(api_port, project_id, password=password, timeout=timeout)
            checks.update(search_checks)
            checks["S0-REINDEX"] = result("NOT_RUN", "Reindex/edit/delete checks follow search validation.")
            return checks
        except Exception as exc:
            failure = redact(f"{type(exc).__name__}: {exc}", (password,))
            return {name: result("FAIL", "Unexpected validation harness error.", error=failure) for name in ("S0-CODE-DIRECT", "S0-TEXT", "S0-CODE-SEARCH", "S0-TEXT-SEARCH", "S0-REINDEX")}
        finally:
            if api_proc is not None:
                try:
                    api_proc.terminate()
                    try:
                        api_proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        api_proc.kill()
                        api_proc.wait(timeout=5)
                except Exception:
                    pass
            if api_log_file is not None and not api_log_file.closed:
                api_log_file.close()

            if container_started:
                inspect = run_command(["docker", "inspect", "--format", "{{index .Config.Labels \"ai-orchestrator-s0\"}}", container], timeout=min(timeout, 10))
                if inspect["exit_code"] == 0 and inspect["log"].strip() == run_id:
                    run_command(["docker", "rm", "-f", container], timeout=min(timeout, 15))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-s", "--suite", choices=("preflight", "indexing", "all"), default="indexing")
    parser.add_argument("-o", "--output-dir", type=Path, default=None)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("-n", "--dry-run", action="store_true", help="Preview only (default)")
    mode.add_argument("-w", "--write", action="store_true", help="Permit isolated disposable fixture/database writes")
    parser.add_argument("-t", "--timeout", type=int, default=120)
    parser.add_argument("-c", "--code-model", default="microsoft/codebert-base")
    parser.add_argument("-m", "--text-model", default="BAAI/bge-base-en-v1.5")
    args = parser.parse_args(argv)
    if args.timeout < 5:
        parser.error("--timeout must be at least 5 seconds")
    run_id = uuid.uuid4().hex
    output = args.output_dir or ROOT / "reports" / f"s0-{run_id[:12]}"
    selected = {"S0-PREFLIGHT"} if args.suite == "preflight" else set(CHECK_IDS) if args.suite == "all" else {"S0-PREFLIGHT", "S0-CODE-DIRECT", "S0-TEXT", "S0-CODE-SEARCH", "S0-TEXT-SEARCH"}
    report: dict[str, Any] = {"schema_version": 1, "run_id": run_id, "started_at": utc_now(), "finished_at": None, "mode": "write" if args.write else "dry-run", "suite": args.suite, "git": git_metadata(), "runtime": {"python": platform.python_version(), "platform": platform.platform(), "executable": sys.executable}, "checks": {name: result("NOT_RUN", "Not selected or staged for a later S0 package.") for name in CHECK_IDS}}
    report["checks"]["S0-PREFLIGHT"] = preflight(args.timeout)
    if args.suite != "preflight":
        if not args.write:
            for name in ("S0-CODE-DIRECT", "S0-TEXT", "S0-CODE-SEARCH", "S0-TEXT-SEARCH"):
                report["checks"][name] = result("BLOCKED", "Preview only; pass --write to create a disposable database and fixture.", command="python -m memory.run_embeddings --mode code|text (credentials via POSTGRES_PASSWORD)", image="pgvector/pgvector:pg16", models=[args.code_model, args.text_model])
        elif report["checks"]["S0-PREFLIGHT"]["status"] != "PASS":
            for name in ("S0-CODE-DIRECT", "S0-TEXT", "S0-CODE-SEARCH", "S0-TEXT-SEARCH"):
                report["checks"][name] = result("BLOCKED", "Preflight prerequisites not met; no database/model started.")
        else:
            report["checks"].update(isolated_indexing(args.timeout, run_id, args.code_model, args.text_model))
    report["finished_at"] = utc_now()
    atomic_report(report, output)
    print(f"S0 report: {output / 'report.md'}")
    for name in sorted(selected):
        entry = report["checks"][name]
        print(f"{name}: {entry['status']} - {entry['detail']}")
    return exit_code(report["checks"], selected)


if __name__ == "__main__":
    raise SystemExit(main())
