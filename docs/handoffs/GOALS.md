# AI Orchestrator – Program Goals

This document gives incoming agents and contributors a shared understanding of what the system must deliver. Hand this file to another LLM when you need help; it distills the core intent, current capabilities, and near-term expectations without extra backstory.

---

## Mission Statement
Build a self-managing orchestration platform that coordinates human users, multiple LLM/CLI workers, and long-lived project memory so tasks move from idea → execution → verification with minimal human babysitting. The orchestrator must:

1. React to new tasks in real time (LISTEN/NOTIFY, filesystem queue) and pick the best worker (Claude/Codex/Gemini/local LLMs).
2. Maintain durable “working memory” (Postgres + pgvector) per system/project/task so future work is smarter and context-aware.
3. Provide transparent monitoring + control surfaces (TUI/WebUI/APIs) so humans can inspect, override, or assign work quickly.

## End-State Vision

- **Single pane of glass:** Web UI + CLI show project status, worker activity, embedding health, model assignments, and memory stats in one place.
- **Hybrid automation:** Orchestrator autonomously routes routine work to local GPUs or remote CLIs while surfacing approvals/edge cases to humans.
- **Evergreen memory:** Each project has tracked repositories, regularly refreshed embeddings, feedback loops, and retention policies.
- **Device-aware scale:** Multiple hosts (Termux, WSL, Windows) can contribute workers and indexing jobs while sharing the same Postgres source of truth.
- **Extensible skills:** New modules (LLM router, embedding pipelines, device trackers) plug in without rewriting core task/queue logic.

## Current Baseline (as of Jan 2026)

- Dockerized FastAPI orchestrator with asyncpg pool, LISTEN/NOTIFY, and filesystem task queue integration.
- CLI worker scripts (claude_worker.sh) executing real tasks and capturing logs/artifacts.
- Memory subsystem code (manager/vector_store/embed_repo) ready but only partially integrated; manual indexing needed.
- Orchestrator Web Viewer (FastAPI + static UI) providing dashboards, task queue status, manual task submission, memory browser, and model selection.
- Project tracking metadata persisted (repo path, embedding status, GPU usage) and exposed via REST/UI with manual “start embedding” control.

## Immediate Goals (MVP Completion)

1. **Stabilize embeddings + memory**
   - Ensure every tracked project has repo path + embedding model recorded.
   - Queue embedding jobs from WebUI (already manual) and monitor completion status.
   - Feed memory search results into task prompts/CLI contexts.

2. **Task routing polish**
   - Support multiple worker types (Claude/Codex/Gemini/local LLM) with concurrency caps.
   - Add failure handling + retries when workers crash or tasks timeout.

3. **UI feedback loop**
   - Persist project-specific filters, show tracking badges, highlight stale embeddings.
   - Provide manual controls for new projects (ask for repo path on creation, allow “do not track”).
   - Surface worker logs/status in near real-time via WebSocket.

## Near-Future Goals

- **Automation for embeddings:** Detect repo changes, schedule reindex automatically, and mark statuses accordingly (ready/stale/error).
- **GPU + model assignment:** Bind specific GPU hosts/models to projects; orchestrator should respect capacity/plans when routing.
- **LLM router integration:** Local llama.cpp server should be selectable for lightweight work; remote APIs reserved for heavy tasks.
- **Memory retention & feedback:** Track access counts/user votes, decay low-value memories, and expose management in UI.
- **Distributed devices:** Allow remote nodes to register as workers/indexers securely, syncing results back to central Postgres/task queue.

## Guiding Principles

- **Postgres is truth:** Tasks, projects, memory metadata, and tracking info must live in the database so every UI/worker sees the same reality.
- **Human-in-the-loop by default:** Any automation should leave observability hooks and manual overrides; no silent long-running jobs.
- **Composable modules:** Memory, task queue, LLM router, and UIs should stay loosely coupled via well-defined APIs.
- **Document once:** Every new feature/endpoint gets captured in README/PROGRESS/GOALS so future agents bootstrap quickly.
- **Test where feasible:** Even smoke tests (pytest/unit or manual scripted checks) beat ad-hoc verification; favor deterministic scripts.

---

Use this checklist when onboarding new agents:

1. Read this `GOALS.md`.
2. Skim `README.md` for quick commands, `PLAN.md` for roadmap, and `PROGRESS.md` for recent work.
3. Review `memory/README.md` + `.../PLAN.md` for the hierarchical memory design.
4. Inspect `docker/orchestrator/main.py` and `orchestrator_web_viewer/*` for current API/UI behavior.
5. Confirm Docker + task queue are running via `./build_all.sh` and WebUI dashboards.

If a task conflicts with the mission or principles above, call it out before implementing.***
