# AI Orchestrator Plan Meets Reality

**Date:** 2026-02-16  
**Audience:** LLM researchers/planners writing future strategy docs for this repo  
**Purpose:** Ground future planning in the code that actually exists and runs, not in stale assumptions.

---

## 1) Executive Reality

The consolidation direction was broadly correct, but several key claims were too optimistic.

- The system is **partially operational**, not "fully working".
- The biggest failures were **interface contract mismatches** (status names, priority ranges), **unimplemented assignment path in web API**, and **split state between DB and filesystem queue**.
- Embedding infrastructure exists, but reliable end-to-end usage is blocked by operational gaps (host-side local worker dependency) and at least one text chunking bug.
- Documentation sprawl was a real source of confusion and has now been reduced (see section 6).

---

## 2) What Was True in `AI_ORCHESTRATOR_CONSOLIDATION_PLAN.md`

The plan got these things right:

- Conflicting docs were actively harming implementation quality.
- PostgreSQL should remain central.
- The current queue architecture causes consistency pain and should move toward a DB-backed claim model.
- Web API + UI needed practical fixes before any framework rewrite conversation.
- Embedding/indexing code exists but had not been exercised reliably in production workflow.

---

## 3) What the Plan Got Wrong or Under-Specified

### 3.1 "Foundation works" was overstated

Code-level mismatches were directly breaking UX:

- UI used task statuses `in_progress|blocked|archived` while DB enum is `todo|in-progress|done`.
- UI/API accepted priority up to `10` while DB constraint is `1..5`.
- `/api/tasks/{id}/assign` in web API returned `501 Not Implemented`.

These are not cosmetic issues. They create missing tasks in UI and failed operations.

### 3.2 Assignment architecture ambiguity

There are two assignment paths:

- `kmtui` assigns directly to filesystem queue.
- Web UI assignment previously did nothing useful (501).

No single canonical assignment flow was enforced.

### 3.3 Embedding path looked "ready" but had hidden blockers

- `local` jobs are not executed by orchestrator itself; they require host-side `bin/local_worker_loop.sh`.
- Text chunking logic in `memory/embed_repo.py` can loop incorrectly on short input in current implementation style.

---

## 4) Current Runtime Model (As of This Update)

### 4.1 Source of state

- **Projects/tasks metadata:** PostgreSQL
- **Worker execution lifecycle/artifacts:** filesystem queue + results
- **Memory vectors:** PostgreSQL (`memory_items`, `code_chunks`, `global_*`)

### 4.2 Queue execution

- Orchestrator polls filesystem queue and assigns work.
- `claude` workers can be spawned by orchestrator.
- `local` jobs require host worker loop.

### 4.3 UI model

- Knowledge Manager view is DB-backed.
- Orchestrator queue view is filesystem-backed.

This hybrid is workable short-term but inherently prone to consistency drift.

---

## 5) Fixes Applied In This Pass (1-3)

### 5.1 Web/API/DB correctness fixes

Implemented in `orchestrator_web_viewer/orchestrator_web_viewer/api/knowledge.py` and static frontend files:

- Normalized task statuses to DB-compatible values: `todo`, `in-progress`, `done`.
- Added alias support for legacy `in_progress` input.
- Enforced priority range `1..5` in API schemas.
- Changed default create priority from `5` to `3` to align with DB/domain defaults.
- Implemented `POST /api/tasks/{task_id}/assign`:
  - Loads DB task
  - Queues it through orchestrator `/tasks/queue`
  - Updates DB task status to `in-progress` for UI continuity

Frontend fixes:

- Removed unsupported statuses from filter controls.
- Updated active defaults to `todo` + `in-progress`.
- Added status normalization for legacy values.
- Improved assign button error handling to surface API failures.

### 5.2 Documentation cleanup / trimming

Archived or removed stale/conflicting docs:

- Archived: `PLAN.md`, `PROGRESS.md`, old viewer/migration/memory strategy docs, personal notes, old long guide.
- Removed: `cliplan.md`.
- Renamed: `docs/BRIEFING_FOR_NEXT_SESSION.md` -> `docs/CURRENT_STATE.md`.
- Updated `README.md` documentation pointers to current files.

### 5.3 Human approval safeguards (owner-in-the-loop mode)

Implemented guardrails to reduce erratic autonomous queueing:

- Queue entry endpoints now require explicit approval fields:
  - `approved=true`
  - `approved_by=<human-id>`
- Covered queue routes include:
  - manual task queueing
  - project embedding queueing
  - global embedding queueing
  - code-index queueing
- kmtui now prompts for explicit confirmation text before queue submission.
- Web UI calls now include explicit approval metadata only during direct user actions.

Current policy intent: **nothing should be queued unless explicitly approved by the user/operator.**

---

## 6) File Hygiene Result

### Active planning surface should now be treated as:

- `README.md` (operations)
- `GOALS.md` (roadmap baseline)
- `docs/CURRENT_STATE.md` (operational snapshot)
- `docs/NEXT_STEPS.md` (short active execution list)
- `rrnow/AI_ORCHESTRATOR_PLAN_MEET_REALITY.md` (this reality-check for future planners)

### Historical/reference docs moved to archive:

`docs/archive/` now contains old planning artifacts that should not drive implementation decisions.

---

## 7) Remaining Gaps (Do Not Ignore)

1. Queue/DB lifecycle still split.
- Assignment and worker transitions are still filesystem-first.
- DB status is only partially synchronized.

2. Embedding reliability is not yet production-safe.
- Local worker dependency needs explicit runtime supervision.
- Text chunking logic needs hardening and tests.
- Historical embedding tasks may linger in queue directories and should be aged out/archived automatically.

3. `kmtui` environment consistency still relies on shell config discipline.
- If `KM_DB_TYPE` or `KM_POSTGRES_*` are wrong, it can silently use SQLite fallback behavior.

4. Health/observability gaps remain.
- Need an explicit endpoint/reporting path for:
  - local worker running state
  - latest embedding run
  - queue->DB reconciliation status
  - approval audit trail by actor and action type

5. Host start-up reliability on WSL/Windows can fail due to Docker credential helper sessions.
- Build scripts need resilient fallback behavior when Docker Desktop auth helper sessions are stale.

---

## 8) Guidance for Future Research LLMs

Do **not** propose major framework rewrites before validating this checklist:

1. Web Knowledge Manager view displays all projects and tasks correctly from DB.
2. Task assignment works from both kmtui and web API.
3. Assigned tasks are actually executed by intended workers.
4. First successful code + text embedding run completes end-to-end.
5. Memory search returns non-empty, relevant results on indexed projects.

If any item fails, prioritize reliability fixes over architecture churn.

---

## 9) Web UI Research Brief (Next High-Leverage Research Area)

Researchers should produce recommendations under **this constraint**:

- "Keep current backend and contracts stable; propose frontend improvements that can be adopted incrementally."

### Required evaluation rubric for candidate UI stacks

Score each stack 1-5 on:

1. Integration friction with existing FastAPI + static routes.
2. Real-time updates ergonomics (WebSocket/event stream UX).
3. Dense data presentation quality (task trees, queue grids, telemetry panes).
4. Aesthetic control and theme system quality.
5. Maintainability for a solo operator with LLM-assisted iteration.

### Candidate stacks to compare

- Keep current server-rendered/static JS and modernize components in place.
- SvelteKit frontend consuming existing APIs.
- React + Vite frontend consuming existing APIs.

### Aesthetic feedback loop requirement

Any recommendation should include a concrete loop:

1. Claude generates variant UI implementations (A/B/C).
2. Variants are scored using explicit heuristics:
   - readability density
   - visual hierarchy
   - error visibility
   - interaction latency
3. User picks direction; Claude refines chosen variant.
4. Preserve API contract while iterating visual/system design.

Do not return generic "modern dashboard" templates; require concrete, inspectable component decisions.

### Mandatory observability scope for UI proposals

Any UI proposal must include first-class views for:

1. Host machine stats:
- CPU usage
- RAM usage
- GPU utilization
- VRAM utilization
- disk I/O (optional but recommended)

2. Worker/CLI utilization:
- active job per worker
- queue wait time
- job run time
- success/failure rates
- output artifact count

3. Budget/time-window stats by CLI/model:
- 5-hour usage window remaining (% and absolute)
- daily/weekly usage remaining (% and absolute)
- rolling spend/consumption trendline

4. Memory pipeline stats:
- memories created/retrieved per second/minute/hour
- embeddings created per second/minute/hour
- per-worker and per-project memory activity
- retrieval hit-rate/acceptance feedback trends

5. Planning/accountability telemetry:
- CLI work plans persisted per task/job
- plan revisions over time
- cross-CLI critique records and adjudication outcome

---

## 10) Implementation Direction From Here

Short-term (execution):

1. Add tests for status/priority contract and assignment API.
2. Add queue->DB reconciliation job or hook to reduce drift.
3. Fix and test text chunking path for embeddings.
4. Add health endpoints for local worker + embedding pipeline.
5. Add queue approval audit logs and approval actor display in UI.
6. Add stale in-progress watchdog with automatic quarantine/archive path.

Medium-term (architecture):

1. Move task claiming/assignment to Postgres (`SKIP LOCKED`) while keeping filesystem artifacts.
2. Keep API contracts stable while improving UI implementation.
3. Promote one canonical orchestration state machine and delete parallel paths.
4. Add a critique/consensus layer where non-owning CLIs can score/critique output, but final accepted plan entries are gated by deterministic adjudication rules and owner approval.

---

## 11) Final Note to Planning LLMs

Future strategy docs must cite current code paths and behavior, not just prior markdown assertions.  
If a claim cannot be tied to a running path in this repository, treat it as hypothesis, not fact.
