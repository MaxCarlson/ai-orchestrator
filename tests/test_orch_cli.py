import importlib.machinery
import importlib.util
from argparse import Namespace
from pathlib import Path


def load_orch_module():
    path = Path(__file__).resolve().parents[1] / "bin" / "orch"
    loader = importlib.machinery.SourceFileLoader("orch_cli_for_test", str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def test_register_payload_defaults_to_gpu_embeddings_and_auto_index(tmp_path, monkeypatch):
    orch = load_orch_module()
    captured = {}

    def fake_post(path, body):
        captured["path"] = path
        captured["body"] = body
        return {
            "project_id": "project-1",
            "id": "project-1",
            "name": tmp_path.name,
            "repo_path": str(tmp_path),
            "is_tracked": True,
            "embedding_status": "indexing",
            "embedding_enabled": True,
            "auto_index_enabled": True,
            "gpu_enabled": True,
            "auto_index": {"status": "queued", "task_id": "task-1"},
        }

    monkeypatch.setattr(orch, "_post", fake_post)
    monkeypatch.setattr(orch, "_write_kmproj", lambda *args, **kwargs: None)

    orch.cmd_project_register(
        Namespace(
            path=str(tmp_path),
            repo_path=None,
            cwd=False,
            name=None,
            no_gpu=False,
            no_embeddings=False,
            no_auto_index=False,
            notes=None,
            kmproj=True,
        )
    )

    assert captured["path"] == "/projects"
    assert captured["body"]["name"] == tmp_path.name
    assert captured["body"]["repo_path"] == str(tmp_path.resolve())
    assert captured["body"]["gpu_enabled"] is True
    assert captured["body"]["embedding_enabled"] is True
    assert captured["body"]["auto_index_enabled"] is True
    assert captured["body"]["approved"] is True
    assert captured["body"]["approved_by"] == "orch-cli"


def test_register_payload_honors_opt_out_flags(tmp_path, monkeypatch):
    orch = load_orch_module()
    captured = {}

    def fake_post(_path, body):
        captured.update(body)
        return {
            "project_id": "project-1",
            "id": "project-1",
            "name": "custom",
            "repo_path": str(tmp_path),
            "is_tracked": True,
            "embedding_status": "disabled",
            "embedding_enabled": False,
            "auto_index_enabled": False,
            "gpu_enabled": False,
            "auto_index": None,
        }

    monkeypatch.setattr(orch, "_post", fake_post)
    monkeypatch.setattr(orch, "_write_kmproj", lambda *args, **kwargs: None)

    orch.cmd_project_register(
        Namespace(
            path=str(tmp_path),
            repo_path=None,
            cwd=False,
            name="custom",
            no_gpu=True,
            no_embeddings=True,
            no_auto_index=True,
            notes=None,
            kmproj=True,
        )
    )

    assert captured["name"] == "custom"
    assert captured["gpu_enabled"] is False
    assert captured["embedding_enabled"] is False
    assert captured["auto_index_enabled"] is False


def test_project_add_alias_parses_as_register():
    orch = load_orch_module()
    parser = orch.build_parser()

    args = parser.parse_args(["project", "add", "/tmp/example", "--no-auto-index"])

    assert args.resource == "project"
    assert args.action == "add"
    assert args.path == "/tmp/example"
    assert args.no_auto_index is True
