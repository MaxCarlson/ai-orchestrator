"""S0 validator safety and report contract tests (no Docker or models required)."""

import json
import sys

from bin import validate_s0


def test_dry_run_does_not_start_disposable_services(tmp_path, monkeypatch):
    monkeypatch.setattr(validate_s0, "preflight", lambda timeout: validate_s0.result("PASS", "Found."))
    monkeypatch.setattr(validate_s0, "isolated_indexing", lambda *args: (_ for _ in ()).throw(AssertionError("Mutation in dry-run")))
    assert validate_s0.main(["-s", "indexing", "-o", str(tmp_path)]) == 2
    report = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))
    assert report["mode"] == "dry-run"
    assert report["checks"]["S0-CODE-DIRECT"]["status"] == "BLOCKED"
    assert report["checks"]["S0-CHAT"]["status"] == "NOT_RUN"
    assert (tmp_path / "report.md").is_file()


def test_exit_status_and_report_preserve_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(validate_s0, "preflight", lambda timeout: validate_s0.result("PASS", "Found."))
    monkeypatch.setattr(validate_s0, "isolated_indexing", lambda *args: {"S0-CODE-DIRECT": validate_s0.result("FAIL", "Missing expected symbol"), "S0-TEXT": validate_s0.result("BLOCKED", "No cached model")})
    assert validate_s0.main(["-w", "-o", str(tmp_path)]) == 1
    checks = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))["checks"]
    assert checks["S0-CODE-DIRECT"]["status"] == "FAIL"
    assert checks["S0-TEXT"]["status"] == "BLOCKED"


def test_preflight_block_prevents_start(tmp_path, monkeypatch):
    monkeypatch.setattr(validate_s0, "preflight", lambda timeout: validate_s0.result("BLOCKED", "Docker unavailable"))
    monkeypatch.setattr(validate_s0, "isolated_indexing", lambda *args: (_ for _ in ()).throw(AssertionError("Should not start")))
    assert validate_s0.main(["-w", "-o", str(tmp_path)]) == 2
    checks = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))["checks"]
    assert checks["S0-CODE-DIRECT"]["status"] == "BLOCKED"


def test_redaction_and_offline_cache_detection():
    log = "postgresql://user:secret@example.org/db POSTGRES_PASSWORD=secret token: anothersecret"
    output = validate_s0.redact(log, ("secret",))
    assert "secret" not in output
    assert "anothersecret" not in output
    assert validate_s0.model_unavailable("LocalEntryNotFoundError")
    assert not validate_s0.model_unavailable("UndefinedTableError")


def test_command_timeout_is_bounded_and_redacted():
    command = validate_s0.run_command([sys.executable, "-c", "print('password=sentinel')"], timeout=5, secret="sentinel")
    assert command["exit_code"] == 0
    assert "sentinel" not in command["log"]
    assert "[REDACTED]" in command["log"]
    timed_out = validate_s0.run_command([sys.executable, "-c", "import time; time.sleep(3)"], timeout=1)
    assert timed_out["exit_code"] is None
    assert timed_out["elapsed_seconds"] < 3


def test_init_scripts_in_repository_are_world_readable():
    init_scripts = validate_s0.ROOT / "docker/postgres/init-scripts"
    assert init_scripts.is_dir()
    sql_files = list(init_scripts.glob("*.sql"))
    assert len(sql_files) >= 2
    for sql_file in sql_files:
        mode = sql_file.stat().st_mode & 0o777
        assert mode & 0o444 == 0o444, f"{sql_file.name} is not world-readable (mode: {oct(mode)})"


def test_stage_init_scripts_normalizes_restrictive_permissions(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    restrictive_file = src / "02_device_tracking.sql"
    restrictive_file.write_text("SELECT 1;\n", encoding="utf-8")
    restrictive_file.chmod(0o600)

    dst = tmp_path / "dst"
    validate_s0.stage_init_scripts(src, dst)

    staged_file = dst / "02_device_tracking.sql"
    assert staged_file.is_file()
    assert (staged_file.stat().st_mode & 0o777) == 0o644


def test_get_container_diagnostics_extracts_state_and_bounded_logs(monkeypatch):
    def mock_run_command(argv, **kwargs):
        if argv[:2] == ["docker", "logs"]:
            return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.01, "log": "secret_pass in log\npsql: error: Permission denied\n"}
        if argv[:2] == ["docker", "inspect"]:
            raw_state = {
                "Status": "exited",
                "Running": False,
                "Paused": False,
                "Restarting": False,
                "ExitCode": 1,
                "Error": "",
                "StartedAt": "2026-09-27T00:00:00Z",
                "FinishedAt": "2026-09-27T00:00:05Z",
                "OtherInternal": "ignore_me",
            }
            return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.01, "log": json.dumps(raw_state)}
        return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.01, "log": ""}

    monkeypatch.setattr(validate_s0, "run_command", mock_run_command)
    diagnostics = validate_s0.get_container_diagnostics("fake-container", password="secret_pass")
    assert "secret_pass" not in diagnostics["container_logs"]
    assert "psql: error: Permission denied" in diagnostics["container_logs"]
    state = diagnostics["container_state"]
    assert state["Status"] == "exited"
    assert state["Running"] is False
    assert state["ExitCode"] == 1
    assert "OtherInternal" not in state


def test_isolated_indexing_captures_diagnostics_on_container_crash(monkeypatch):
    commands_run = []

    def mock_run_command(argv, **kwargs):
        commands_run.append(list(argv))
        cmd_str = " ".join(argv)
        if "docker run" in cmd_str:
            return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.1, "log": "cid123\n"}
        if "docker port" in cmd_str:
            return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.01, "log": "5432/tcp -> 127.0.0.1:54321\n"}
        if "docker inspect --format {{json .State}}" in cmd_str:
            # Simulate container having exited with error
            return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.01, "log": json.dumps({"Status": "exited", "Running": False, "ExitCode": 1})}
        if "docker logs" in cmd_str:
            return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.01, "log": "psql: error: /docker-entrypoint-initdb.d/02_device_tracking.sql: Permission denied\n"}
        if "docker inspect --format {{index .Config.Labels" in cmd_str:
            return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.01, "log": "test-run-id\n"}
        if "docker rm -f" in cmd_str:
            return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.01, "log": "cid123\n"}
        return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.01, "log": ""}

    monkeypatch.setattr(validate_s0, "run_command", mock_run_command)
    res = validate_s0.isolated_indexing(timeout=10, run_id="test-run-id", code_model="cmodel", text_model="tmodel")

    assert res["S0-CODE-DIRECT"]["status"] == "BLOCKED"
    assert "exited prematurely" in res["S0-CODE-DIRECT"]["detail"]
    assert "Permission denied" in res["S0-CODE-DIRECT"]["evidence"]["container_logs"]
    assert res["S0-CODE-DIRECT"]["evidence"]["container_state"]["ExitCode"] == 1
    # Verify docker rm -f was called to safely cleanup
    assert any(cmd[:3] == ["docker", "rm", "-f"] for cmd in commands_run)
    # Verify docker run did NOT use --rm so inspection succeeded before cleanup
    run_cmd = next(cmd for cmd in commands_run if cmd[:2] == ["docker", "run"])
    assert "--rm" not in run_cmd


def test_readiness_polling_uses_tcp_check(monkeypatch):
    commands_run = []

    def mock_run_command(argv, **kwargs):
        commands_run.append(list(argv))
        cmd_str = " ".join(argv)
        if "docker run" in cmd_str:
            return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.1, "log": "cid123\n"}
        if "docker port" in cmd_str:
            return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.01, "log": "5432/tcp -> 127.0.0.1:54321\n"}
        if "docker inspect --format {{json .State}}" in cmd_str:
            return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.01, "log": json.dumps({"Status": "running", "Running": True, "ExitCode": 0})}
        if "pg_isready" in cmd_str:
            return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.01, "log": "127.0.0.1:5432 - accepting connections\n"}
        if "psql" in cmd_str:
            return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.01, "log": "INSERT 0 1\n"}
        if "memory.run_embeddings" in cmd_str:
            return {"argv": argv, "exit_code": 1, "elapsed_seconds": 0.01, "log": "LocalEntryNotFoundError: model not cached\n"}
        if "docker inspect --format {{index .Config.Labels" in cmd_str:
            return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.01, "log": "test-run-id\n"}
        if "docker rm -f" in cmd_str:
            return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.01, "log": "cid123\n"}
        return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.01, "log": ""}

    monkeypatch.setattr(validate_s0, "run_command", mock_run_command)
    res = validate_s0.isolated_indexing(timeout=10, run_id="test-run-id", code_model="cmodel", text_model="tmodel")

    # Confirm pg_isready was called with TCP flags
    pg_isready_cmds = [cmd for cmd in commands_run if "pg_isready" in cmd]
    assert len(pg_isready_cmds) > 0
    cmd = pg_isready_cmds[0]
    assert "-h" in cmd and "127.0.0.1" in cmd
    assert "-p" in cmd and "5432" in cmd
    # Confirm models offline cache miss results in BLOCKED
    assert res["S0-CODE-DIRECT"]["status"] == "BLOCKED"
    assert res["S0-TEXT"]["status"] == "BLOCKED"



def test_project_tracking_init_schema_covers_orchestrator_schema():
    """Fresh DB bootstrap must contain every column the API creates at runtime."""
    import re

    init_sql = (validate_s0.ROOT / "docker/postgres/init-scripts/03_project_tracking.sql").read_text(encoding="utf-8")
    orchestrator = (validate_s0.ROOT / "docker/orchestrator/main.py").read_text(encoding="utf-8")

    def columns(source):
        match = re.search(
            r"CREATE TABLE IF NOT EXISTS project_tracking\s*\((.*?)\n\s*\);",
            source,
            re.DOTALL,
        )
        assert match, "project_tracking CREATE TABLE definition not found"
        return {
            line.strip().split()[0].rstrip(",")
            for line in match.group(1).splitlines()
            if line.strip() and not line.strip().startswith("--")
        }

    assert columns(orchestrator) <= columns(init_sql)


def test_long_command_emits_visible_heartbeat(monkeypatch, capsys):
    import time

    def slow_command(argv, **kwargs):
        time.sleep(0.05)
        return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.05, "log": ""}

    monkeypatch.setattr(validate_s0, "run_command", slow_command)
    result = validate_s0.run_command_with_heartbeat(
        ["fake-indexer"],
        timeout=1,
        label="Code indexing",
        interval=0.005,
    )

    assert result["exit_code"] == 0
    assert "Code indexing still running" in capsys.readouterr().err


def test_execute_search_validation_success(monkeypatch):
    calls = []

    def mock_http_request(url, *, method="GET", payload=None, timeout=30.0, label=""):
        calls.append({"url": url, "method": method, "payload": payload})
        if "/memory/code-search/test-project" in url:
            return {
                "status_code": 200,
                "elapsed_seconds": 0.05,
                "body": [
                    {
                        "symbol_name": "s0_nebula_probe",
                        "file_path": "fixture/probe.py",
                        "start_line": 1,
                        "end_line": 2,
                        "similarity": 0.88,
                        "rrf_score": 0.5,
                    }
                ],
                "error": None,
            }
        if "/memory/code-search/" in url:  # decoy
            return {
                "status_code": 200,
                "elapsed_seconds": 0.02,
                "body": [],
                "error": None,
            }
        if "/memory/text-search/test-project" in url:
            return {
                "status_code": 200,
                "elapsed_seconds": 0.05,
                "body": {
                    "count": 1,
                    "results": [
                        {
                            "file_path": "fixture/readme.md",
                            "content": "S0 nebula violet is the indexed fixture fact.\n",
                            "similarity": 0.82,
                            "rrf_score": 0.45,
                        }
                    ],
                },
                "error": None,
            }
        if "/memory/text-search/" in url:  # decoy
            return {
                "status_code": 200,
                "elapsed_seconds": 0.02,
                "body": {"count": 0, "results": []},
                "error": None,
            }
        return {"status_code": 404, "elapsed_seconds": 0.01, "body": None, "error": "Not found"}

    monkeypatch.setattr(validate_s0, "http_request_with_heartbeat", mock_http_request)

    res = validate_s0.execute_search_validation(api_port=9999, project_id="test-project")

    assert res["S0-CODE-SEARCH"]["status"] == "PASS"
    assert "s0_nebula_probe" in res["S0-CODE-SEARCH"]["detail"]
    assert res["S0-CODE-SEARCH"]["evidence"]["status_code"] == 200
    assert len(res["S0-CODE-SEARCH"]["evidence"]["matching_chunks"]) == 1
    assert res["S0-CODE-SEARCH"]["evidence"]["decoy_test"]["results_count"] == 0

    assert res["S0-TEXT-SEARCH"]["status"] == "PASS"
    assert "readme.md" in res["S0-TEXT-SEARCH"]["detail"]
    assert res["S0-TEXT-SEARCH"]["evidence"]["status_code"] == 200
    assert len(res["S0-TEXT-SEARCH"]["evidence"]["matching_chunks"]) == 1
    assert res["S0-TEXT-SEARCH"]["evidence"]["decoy_test"]["results_count"] == 0


def test_execute_search_validation_fails_on_missing_symbol_or_fact(monkeypatch):
    def mock_http_request(url, *, method="GET", payload=None, timeout=30.0, label=""):
        if "/memory/code-search/test-project" in url:
            return {
                "status_code": 200,
                "elapsed_seconds": 0.05,
                "body": [
                    {
                        "symbol_name": "unrelated_symbol",
                        "file_path": "fixture/other.py",
                    }
                ],
                "error": None,
            }
        if "/memory/code-search/" in url:
            return {"status_code": 200, "elapsed_seconds": 0.01, "body": [], "error": None}
        if "/memory/text-search/test-project" in url:
            return {
                "status_code": 200,
                "elapsed_seconds": 0.05,
                "body": {
                    "count": 1,
                    "results": [
                        {
                            "file_path": "fixture/other.md",
                            "content": "No known fact here.\n",
                        }
                    ],
                },
                "error": None,
            }
        if "/memory/text-search/" in url:
            return {"status_code": 200, "elapsed_seconds": 0.01, "body": {"count": 0, "results": []}, "error": None}
        return {"status_code": 404, "elapsed_seconds": 0.01, "body": None, "error": "Not found"}

    monkeypatch.setattr(validate_s0, "http_request_with_heartbeat", mock_http_request)

    res = validate_s0.execute_search_validation(api_port=9999, project_id="test-project")

    assert res["S0-CODE-SEARCH"]["status"] == "FAIL"
    assert "did not include 's0_nebula_probe'" in res["S0-CODE-SEARCH"]["detail"]

    assert res["S0-TEXT-SEARCH"]["status"] == "FAIL"
    assert "did not include fixture fact in readme.md" in res["S0-TEXT-SEARCH"]["detail"]


def test_execute_search_validation_fails_on_project_scope_leak(monkeypatch):
    def mock_http_request(url, *, method="GET", payload=None, timeout=30.0, label=""):
        # Leaking results for decoy project query
        if "/memory/code-search/" in url:
            return {
                "status_code": 200,
                "elapsed_seconds": 0.02,
                "body": [{"symbol_name": "s0_nebula_probe", "file_path": "probe.py"}],
                "error": None,
            }
        if "/memory/text-search/" in url:
            return {
                "status_code": 200,
                "elapsed_seconds": 0.02,
                "body": {"count": 1, "results": [{"file_path": "readme.md", "content": "S0 nebula violet"}]},
                "error": None,
            }
        return {"status_code": 404, "elapsed_seconds": 0.01, "body": None, "error": "Not found"}

    monkeypatch.setattr(validate_s0, "http_request_with_heartbeat", mock_http_request)

    res = validate_s0.execute_search_validation(api_port=9999, project_id="test-project")

    assert res["S0-CODE-SEARCH"]["status"] == "FAIL"
    assert "project isolation" in res["S0-CODE-SEARCH"]["detail"]

    assert res["S0-TEXT-SEARCH"]["status"] == "FAIL"
    assert "project isolation" in res["S0-TEXT-SEARCH"]["detail"]


def test_wait_for_api_readiness_detects_exit():
    class DummyProc:
        returncode = 1
        def poll(self):
            return 1

    ready, exited, detail = validate_s0.wait_for_api_readiness(api_port=9999, api_proc=DummyProc(), timeout=2)
    assert not ready
    assert exited
    assert "exit code 1" in detail


def test_wait_for_api_readiness_succeeds(monkeypatch):
    class DummyProc:
        returncode = None
        def poll(self):
            return None

    class DummyResponse:
        status = 200
        def read(self):
            return b'{"status": "healthy"}'
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass

    monkeypatch.setattr(validate_s0.urllib.request, "urlopen", lambda req, timeout: DummyResponse())

    ready, exited, detail = validate_s0.wait_for_api_readiness(api_port=9999, api_proc=DummyProc(), timeout=2)
    assert ready
    assert not exited
    assert "healthy" in detail


def test_http_request_with_heartbeat_handles_httperror(monkeypatch):
    import io
    import urllib.error

    def mock_urlopen(req, timeout):
        raise urllib.error.HTTPError(
            url="http://127.0.0.1:8000",
            code=500,
            msg="Internal Server Error",
            hdrs={},
            fp=io.BytesIO(b'{"detail": "DB crashed"}'),
        )

    monkeypatch.setattr(validate_s0.urllib.request, "urlopen", mock_urlopen)

    res = validate_s0.http_request_with_heartbeat("http://127.0.0.1:8000/err", interval=0.01)
    assert res["status_code"] == 500
    assert res["body"] == {"detail": "DB crashed"}
    assert "HTTPError 500" in res["error"]


def test_isolated_indexing_cleans_up_api_process_on_failure(monkeypatch):
    terminated = []

    class MockProc:
        returncode = 0
        def poll(self):
            return 0
        def terminate(self):
            terminated.append("terminated")
        def wait(self, timeout=None):
            return 0

    def mock_run_command(argv, **kwargs):
        cmd_str = " ".join(argv)
        if "docker run" in cmd_str:
            return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.1, "log": "cid123\n"}
        if "docker port" in cmd_str:
            return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.01, "log": "5432/tcp -> 127.0.0.1:54321\n"}
        if "docker inspect --format {{json .State}}" in cmd_str:
            return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.01, "log": json.dumps({"Status": "running", "Running": True, "ExitCode": 0})}
        if "pg_isready" in cmd_str:
            return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.01, "log": "accepting\n"}
        if "psql" in cmd_str:
            return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.01, "log": "INSERT 0 1\n"}
        if "memory.run_embeddings" in cmd_str:
            return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.01, "log": "done\n"}
        if "docker inspect --format {{index .Config.Labels" in cmd_str:
            return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.01, "log": "test-run-id\n"}
        if "docker rm -f" in cmd_str:
            return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.01, "log": "cid123\n"}
        return {"argv": argv, "exit_code": 0, "elapsed_seconds": 0.01, "log": ""}

    monkeypatch.setattr(validate_s0, "run_command", mock_run_command)
    async def mock_inspect(*args, **kwargs):
        return {
            "code": [{"symbol_name": "s0_nebula_probe", "dims": 768, "start_line": 1}],
            "text": [{"contains_nonce": True, "file_path": "readme.md"}],
            "project_tracking": {"embedding_status": "ready", "embedding_model_id": "cmodel", "text_embedding_model_id": "tmodel"},
        }
    monkeypatch.setattr(validate_s0, "inspect_index", mock_inspect)
    monkeypatch.setattr(validate_s0.subprocess, "Popen", lambda *args, **kwargs: MockProc())
    monkeypatch.setattr(validate_s0, "wait_for_api_readiness", lambda *args, **kwargs: (True, False, "ready"))

    def raise_err(*args, **kwargs):
        raise RuntimeError("simulated search crash")

    monkeypatch.setattr(validate_s0, "execute_search_validation", raise_err)

    res = validate_s0.isolated_indexing(timeout=10, run_id="test-run-id", code_model="cmodel", text_model="tmodel")
    assert "simulated search crash" in res["S0-CODE-SEARCH"]["evidence"]["error"]
    assert "terminated" in terminated


