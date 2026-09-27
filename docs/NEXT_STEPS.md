# AI Orchestrator — Current Execution Priorities

**Status reviewed:** 2026-09-26 America/Los_Angeles / 2026-09-27 UTC. Architecture baseline `3e14e826bca044f88dd52cd951526b8bd5f43f83`; latest host indexing evidence is for commit `60740004d73d680da448201ee1592f59538e4fa2`.

The [architecture plan](plans/20260926_ai-assistant/00_implementation-plan.md) defines S0–S8. The [execution plan](plans/20260926_ai-assistant/02_execution-plan-and-validation.md) supplies current code findings, ordered work packages and acceptance checks. Checked implementation items indicate source exists; live evidence is stated separately below.

**Host evidence:** On WSL2, `S0-PREFLIGHT`, `S0-CODE-DIRECT`, `S0-TEXT`, `S0-CODE-SEARCH`, and `S0-TEXT-SEARCH` passed against the run-owned disposable database and isolated loopback API process. The report is local at `reports/s0-e2e47e7974e7/report.md`; reports are untracked and not committed.

## P0 — Repeatable S0 validation and immediate containment

- [x] Implement S0.1: project-local validator, disposable fixture resources, preview default, explicit live writes and stable JSON/Markdown evidence.
- [x] Deliver exact pull/run/report instructions before requesting host validation.
- [ ] In parallel, S1.1: address published service exposure and credentials in task commands/logs.
- [ ] Record dependency/runtime/schema versions and actual host/container launch paths.
- [ ] Repair onboarding instructions that refer to scripts-repo-only paths.

## P1 — Local model chat

- [x] Source contains the aioc startup project-status fix and `--serve` path.
- [x] Source checks LM Studio readiness before local requests.
- [ ] Prove server readiness, loaded model and direct model answer independently.
- [ ] Verify a real reply and second turn through aioc.
- [ ] Verify web `/ws/chat` streaming with the same model.
- [ ] Capture restart/history behavior; full replay remains an S2 requirement and is expected to fail with current user-only session persistence.

## P2 — Code/text indexing and worker proof

- [x] Run direct code and text indexing on a disposable fixture with real PostgreSQL and cached embedding models; verify expected symbol/source, 768D code vector, and project tracking status/model IDs.
- [x] Verify isolation against a decoy project and check cross-project search cannot return its rows.
- [x] Verify `POST /memory/code-search/{project_id}` and `POST /memory/text-search/{project_id}` return the expected fixture sources.
- [ ] Capture unchanged/edit/delete/rename reindex behavior. Current code indexer lacks deletion reconciliation; retain a failing reproduction.
- [ ] Run a harmless task and queued code/text indexing through an isolated host worker.
- [ ] Verify loop restart and continued processing after a failed task.
- [ ] Repair route-to-worker force-reindex propagation and any first live blocking defect.
- [ ] Add a live retrieval-result collector for the existing offline scorer in `eval/retrieval/run_eval.py`; do not claim that scorer itself queries the API.

## P3 — Memory completion after scope/history prerequisites

- [x] Kind taxonomy, memory/global-memory kind columns and MemoryManager kind filtering exist.
- [x] Note ingestion and candidate promotion CLIs exist.
- [ ] Validate these paths against a real isolated database; no completed memory workflow is established yet.
- [ ] Fix `ingest_notes --kind` being printed but not persisted.
- [ ] Finish kind/scope/review-state support through text-query memory APIs.
- [ ] Add durable candidate review, idempotent promotion, provenance, revisions and explicit write gating.
- [ ] Inject reviewed memory only after S2 context ownership and S4 retrieval gates.

Document search is `POST /memory/text-search/{project_id}`. Memory-item text search is `POST /memory/search-text`; `POST /memory/search` accepts an embedding. Keep these contracts distinct.

## P4 — UX

- [ ] Add project/conversation/retrieval/approval status as their underlying contracts land.
- [ ] Retain scroll-wheel and arrow-key improvements as small UX tasks after current runtime proof.

## Existing deterministic validation

Run from the repository root. These commands do not prove live indexing, model readiness or restart recovery:

```bash
PYTHONPATH=. python -m pytest -q tests/test_code_chunking_multilanguage.py tests/test_code_search.py tests/test_retrieval_eval.py tests/test_memory_kinds.py tests/test_memory_notes_cli.py tests/test_retrieval.py tests/test_task_queue_controls.py tests/test_orch_cli.py tests/test_source_ingestion.py
```

```bash
bash tests/local_worker_loop_test.sh
```

```bash
(cd chat && bun run typecheck && bun test)
```

The user reported 31 focused Python tests passing on main `47a768d9`, with seven datetime deprecation warnings. This review did not execute the commands. Use the installed Bun executable or its explicit local path if it is not on PATH. Record environment failures rather than silently skipping them.
