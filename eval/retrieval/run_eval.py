#!/usr/bin/env python3
"""Small retrieval evaluation runner for ai-orchestrator.

The default path is intentionally offline-friendly: pass a JSON results file
and the runner scores paths/symbols against qrels. Live API evaluation can be
added after indexing is proven on this repo.
"""

from __future__ import annotations

import argparse
import csv
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

try:
    import yaml
except Exception:  # pragma: no cover - dependency exists in project env
    yaml = None


@dataclass(frozen=True)
class Query:
    query_id: str
    text: str
    domain: str
    scope: str


@dataclass(frozen=True)
class Judgement:
    query_id: str
    path: str
    symbol: str | None
    grade: int


def _load_yaml(path: Path) -> Any:
    if yaml is None:
        raise RuntimeError("PyYAML is required to load retrieval eval YAML files")
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def load_queries(path: Path) -> list[Query]:
    data = _load_yaml(path)
    return [
        Query(
            query_id=str(row["id"]),
            text=str(row["text"]),
            domain=str(row["domain"]),
            scope=str(row["scope"]),
        )
        for row in data.get("queries", [])
    ]


def load_qrels(path: Path) -> dict[str, list[Judgement]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        rows = csv.DictReader(handle, delimiter="\t")
        by_query: dict[str, list[Judgement]] = {}
        for row in rows:
            judgement = Judgement(
                query_id=row["query_id"],
                path=row["path"],
                symbol=row["symbol"] or None,
                grade=int(row["grade"]),
            )
            by_query.setdefault(judgement.query_id, []).append(judgement)
        return by_query


def load_results(path: Path) -> dict[str, list[dict[str, Any]]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and "results" in data:
        data = data["results"]
    if not isinstance(data, dict):
        raise ValueError("Results JSON must be an object keyed by query id")
    return {str(query_id): list(rows) for query_id, rows in data.items()}


def _result_matches_judgement(result: dict[str, Any], judgement: Judgement) -> bool:
    result_path = str(result.get("path") or result.get("file_path") or "")
    result_symbol = result.get("symbol") or result.get("symbol_name")
    if result_path != judgement.path:
        return False
    if judgement.symbol is None:
        return True
    return result_symbol == judgement.symbol


def _is_relevant(result: dict[str, Any], judgements: Iterable[Judgement], min_grade: int) -> bool:
    return any(j.grade >= min_grade and _result_matches_judgement(result, j) for j in judgements)


def recall_at_k(
    results: list[dict[str, Any]],
    judgements: list[Judgement],
    *,
    k: int,
    min_grade: int = 1,
) -> float:
    relevant = [j for j in judgements if j.grade >= min_grade]
    if not relevant:
        return 0.0
    found = 0
    for judgement in relevant:
        if any(_result_matches_judgement(result, judgement) for result in results[:k]):
            found += 1
    return found / len(relevant)


def mrr_at_k(
    results: list[dict[str, Any]],
    judgements: list[Judgement],
    *,
    k: int,
    min_grade: int = 1,
) -> float:
    for rank, result in enumerate(results[:k], start=1):
        if _is_relevant(result, judgements, min_grade):
            return 1.0 / rank
    return 0.0


def score_results(
    queries: list[Query],
    qrels: dict[str, list[Judgement]],
    results: dict[str, list[dict[str, Any]]],
    *,
    ks: Iterable[int],
    min_grade: int = 1,
) -> dict[str, Any]:
    query_scores: dict[str, dict[str, float]] = {}
    totals: dict[str, float] = {}
    scored_count = 0
    for query in queries:
        judgements = qrels.get(query.query_id, [])
        if not judgements:
            continue
        scored_count += 1
        rows = results.get(query.query_id, [])
        scores: dict[str, float] = {}
        for k in ks:
            scores[f"recall@{k}"] = recall_at_k(rows, judgements, k=k, min_grade=min_grade)
            scores[f"mrr@{k}"] = mrr_at_k(rows, judgements, k=k, min_grade=min_grade)
        query_scores[query.query_id] = scores
        for key, value in scores.items():
            totals[key] = totals.get(key, 0.0) + value

    aggregate = {
        key: (value / scored_count if scored_count else 0.0)
        for key, value in sorted(totals.items())
    }
    return {"queries_scored": scored_count, "aggregate": aggregate, "by_query": query_scores}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Score retrieval results against local qrels.")
    parser.add_argument("--queries", type=Path, default=Path("eval/retrieval/queries.yaml"))
    parser.add_argument("--qrels", type=Path, default=Path("eval/retrieval/qrels.tsv"))
    parser.add_argument("--results", type=Path, required=True, help="JSON results keyed by query id")
    parser.add_argument("--k", type=int, nargs="+", default=[1, 3, 5, 10])
    parser.add_argument("--min-grade", type=int, default=1)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    scores = score_results(
        load_queries(args.queries),
        load_qrels(args.qrels),
        load_results(args.results),
        ks=args.k,
        min_grade=args.min_grade,
    )
    print(json.dumps(scores, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
