from pathlib import Path

import importlib.machinery
import importlib.util
import sys


def _load_runner():
    path = Path("eval/retrieval/run_eval.py")
    loader = importlib.machinery.SourceFileLoader("retrieval_eval_runner", str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    sys.modules[loader.name] = module
    loader.exec_module(module)
    return module


def test_retrieval_eval_metrics_score_expected_paths_and_symbols():
    runner = _load_runner()
    judgements = [
        runner.Judgement("q1", "memory/retrieval.py", "hybrid_search", 3),
        runner.Judgement("q1", "memory/models.py", None, 1),
    ]
    results = [
        {"file_path": "memory/code_search.py", "symbol_name": "search_code"},
        {"file_path": "memory/retrieval.py", "symbol_name": "hybrid_search"},
    ]

    assert runner.recall_at_k(results, judgements, k=1) == 0.0
    assert runner.recall_at_k(results, judgements, k=2) == 0.5
    assert runner.mrr_at_k(results, judgements, k=2) == 0.5


def test_retrieval_eval_loads_seed_fixtures():
    runner = _load_runner()
    queries = runner.load_queries(Path("eval/retrieval/queries.yaml"))
    qrels = runner.load_qrels(Path("eval/retrieval/qrels.tsv"))

    assert len(queries) >= 10
    assert "ret-001" in qrels
    assert any(j.path == "memory/retrieval.py" for j in qrels["ret-001"])
