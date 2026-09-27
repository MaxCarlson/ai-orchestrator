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
            r"CREATE TABLE IF NOT EXISTS project_tracking\\s*\\((.*?)\\n\\s*\\);",
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
