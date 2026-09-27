# S0 validator: disposable direct indexing smoke

This is the first S0.1 slice. `bin/validate_s0.py` checks host prerequisites, then (with `--write`) runs the existing `memory.run_embeddings` entrypoint against a generated Python and Markdown fixture in a **new, run-owned PostgreSQL container**. It checks the resulting rows for the expected Python symbol, 768-dimensional vector and document fact. It does not start the existing Compose stack or use its `docker_postgres_data` external volume. It does not call `/memory/code-index/{project_id}`, which currently places a database password in a task command. Search endpoints, queue, chat, history and reindex remain `NOT_RUN`; a direct insert is not an API or worker proof.

## Troubleshooting and Root Cause History

### Disposable Database Startup Blocker (Resolved)

**Observed Failure:**
Live validation on WSL2/Linux waited 180 seconds, then marked `S0-CODE-DIRECT` and `S0-TEXT` as `BLOCKED` with `"Disposable database did not become ready within timeout."` Check evidence was empty and the container was gone.

**Root Causes Identified:**
1. **Init Script Permissions (`02_device_tracking.sql`):** `docker/postgres/init-scripts/02_device_tracking.sql` was checked out/stored with host mode `0600` (`-rw-------`). When mounted read-only into `/docker-entrypoint-initdb.d`, the container process running as UID 999 (`postgres`) was denied access (`psql: error: /docker-entrypoint-initdb.d/02_device_tracking.sql: Permission denied`), causing `docker-entrypoint.sh` to abort immediately with exit code 1.
2. **Container Disappearance (`--rm`):** `bin/validate_s0.py` passed `--rm` to `docker run`. When the container crashed during initdb, Docker immediately destroyed it, leaving no container for post-mortem inspection or log retrieval.
3. **Socket Race Condition (`pg_isready`):** Polling used `docker exec container pg_isready` without `-h 127.0.0.1`. In official PostgreSQL containers, `docker-entrypoint.sh` runs init scripts against a temporary Unix-socket-only server (`-c listen_addresses=''`). Polling Unix socket reported readiness prematurely while init scripts were still running, and connection attempts during temporary server shutdown were dropped (`ConnectionResetError`).
4. **Missing Diagnostics & Heartbeat:** The polling loop lacked container exit detection and ran quietly for the full 180s without heartbeat. On failure, no startup logs or container state were saved into `evidence`.
5. **Schema Gap (`project_tracking`):** `project_tracking` table was originally created dynamically in `docker/orchestrator/main.py` but omitted from `docker/postgres/init-scripts/`, causing `run_embeddings.py` to fail with `UndefinedTableError` once database startup succeeded.

**Fix Applied:**
- Set `chmod 644 docker/postgres/init-scripts/02_device_tracking.sql`.
- Added `docker/postgres/init-scripts/03_project_tracking.sql` with mode `0644`.
- `bin/validate_s0.py`: Added `stage_init_scripts` to stage init scripts into a disposable workspace with normalized `0o644` file and `0o755` directory permissions before bind mounting, immunizing runs from host umask/permission drift.
- `bin/validate_s0.py`: Removed `--rm` from `docker run`. Container cleanup is handled in `finally` via verified run-label match with `docker rm -f`.
- `bin/validate_s0.py`: Readiness polling uses TCP (`-h 127.0.0.1 -p 5432 -U s0_user -d s0_db`), checks `docker inspect` for premature container exit on every cycle, logs 5s progress heartbeats, and captures bounded, redacted container logs and safe inspect state in `evidence` on failure.

## Operator commands

From the root of `ai-orchestrator`, on branch `agent/s0-disposable-db-startup-fix`:

1. Run the deterministic regression tests (no Docker daemon or model weights required):
```bash
python -m py_compile bin/validate_s0.py tests/test_validate_s0.py
PYTHONPATH=. python -m pytest -q tests/test_validate_s0.py
```

2. Preview dry-run:
```bash
python bin/validate_s0.py -s indexing -n -o "$(mktemp -d)/s0-preview"
```

3. Ensure Docker is running and `pgvector/pgvector:pg16` is cached:
```bash
docker pull pgvector/pgvector:pg16
```

4. Execute disposable database validation (with model downloads disabled):
```bash
python bin/validate_s0.py -s indexing -w -t 180
```

With the database startup fix applied, the disposable database initializes in ~5-10s with visible progress heartbeats. If offline model weights (`microsoft/codebert-base` and `BAAI/bge-base-en-v1.5`) are not yet cached in `~/.cache/huggingface/hub`, `S0-CODE-DIRECT` and `S0-TEXT` will cleanly report `BLOCKED: Code/Text model unavailable in the offline cache.` with exit code 2, verifying database startup independently from model availability.

## Status and limits

- `PASS` requires a successful subprocess and a specific row assertion; `FAIL` records a command or row assertion that executed and failed; `BLOCKED` means a prerequisite or explicit write flag is missing; `NOT_RUN` means the check is staged or unselected.
- Exit 0 means all selected required checks passed, exit 1 means at least one executed check failed, and exit 2 means there are blockers and no executed failures. `argparse` also uses exit 2 for invalid options.
- Reports include timestamps, repository branch/commit/dirty bit, Python/platform, safe command arguments, bounded redacted logs, status, fixture project ID and DB extension version when available. Credential values are omitted.
- Offline model mode is enforced (`HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `HF_DATASETS_OFFLINE=1`). A missing cached model is `BLOCKED`; other indexing failures are `FAIL` and need the logged reproduction investigated. A cached model can still be incompatible with the fixed vector(768) schema; that is a real failed assertion.
- Direct code and document checks are ordered. The indexer currently scans all files, so this fixture has only two tiny files. This step does not establish ignore handling, deletion reconciliation, model replacement, API search ranking or integration with the host worker.

Follow up after the first report: repair the smallest observed failure, then extend this validator with an isolated API, search/reindex assertions, queue, real LM Studio chat and persistence replay. The full acceptance criteria are in `docs/plans/20260926_ai-assistant/02_execution-plan-and-validation.md`.

