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
