# S0 validator: disposable indexing and search endpoint validation

This S0.1 slice extends the validator to exercise the existing `POST /memory/code-search/{project_id}` and `POST /memory/text-search/{project_id}` endpoints against the validator's run-owned disposable PostgreSQL fixture. `bin/validate_s0.py` checks host prerequisites, runs direct indexing for code and text fixtures, starts a validator-owned API process bound strictly to loopback (`127.0.0.1`), polls API `/health` readiness with heartbeats, and asserts expected symbols, document facts, and project scoping (decoy project query isolation). It does not start the existing Compose stack or use its `docker_postgres_data` external volume. It does not implement reindex, worker, chat, or history checks.

## Latest host result

On WSL2, `S0-PREFLIGHT`, `S0-CODE-DIRECT`, `S0-TEXT`, `S0-CODE-SEARCH`, and `S0-TEXT-SEARCH` passed.
- Direct code indexing created the 768D code vector and updated tracking state.
- Direct text indexing created the text chunk and updated tracking state.
- `POST /memory/code-search/{project_id}` returned the indexed symbol `s0_nebula_probe` in `probe.py` with similarity ~0.97 and verified that querying a decoy project returned 0 results.
- `POST /memory/text-search/{project_id}` (with `use_reranker: false` to reuse the cached `BAAI/bge-base-en-v1.5` text model without requiring an uncached cross-encoder) returned the indexed fact `"S0 nebula violet"` in `readme.md` with similarity ~0.80 and verified that querying a decoy project returned 0 results.
- Both the API process and disposable Docker container were cleaned up in `finally`.

## Troubleshooting and Root Cause History

### 1. Orchestrator Settings Extra Keys Rejection (Resolved)

**Observed Failure:**
When launching the API process outside Docker (`docker/orchestrator/main.py`), Pydantic Settings raised a `ValidationError` with 13 extra forbidden inputs (`pgadmin_email`, `ko_web_*`, etc.).

**Root Cause:**
Inside Docker, `docker/orchestrator/*.py` runs in `/app` where `.env` is not present. On the host, the root `.env` exists. Pydantic v2 `BaseSettings` defaults to `extra='forbid'` unless configured. Because `Settings.Config` lacked `extra = "ignore"`, unrecognized keys in `.env` aborted startup.

**Fix Applied:**
Added `extra = "ignore"` to `Settings.Config` in `docker/orchestrator/main.py`.

### 2. Disposable Database Startup Blocker (Resolved)

**Observed Failure:**
Live validation on WSL2/Linux waited 180 seconds, then marked `S0-CODE-DIRECT` and `S0-TEXT` as `BLOCKED` with `"Disposable database did not become ready within timeout."` Check evidence was empty and the container was gone.

**Root Causes Identified:**
1. **Init Script Permissions (`02_device_tracking.sql`):** `docker/postgres/init-scripts/02_device_tracking.sql` was checked out with host mode `0600`. The container process running as UID 999 (`postgres`) was denied access (`psql: error: ... Permission denied`), causing `docker-entrypoint.sh` to abort immediately with exit code 1.
2. **Container Disappearance (`--rm`):** `bin/validate_s0.py` passed `--rm` to `docker run`. When the container crashed during initdb, Docker destroyed it before post-mortem inspection.
3. **Socket Race Condition (`pg_isready`):** Polling used Unix socket without `-h 127.0.0.1`, reporting readiness prematurely while init scripts were still running on the temporary server.
4. **Missing Diagnostics & Heartbeat:** The polling loop ran quietly without heartbeat or exit detection.
5. **Schema Gap (`project_tracking`):** `project_tracking` was omitted from `docker/postgres/init-scripts/`, causing `UndefinedTableError`.

**Fix Applied:**
- Normalized init script permissions and added `03_project_tracking.sql`.
- `bin/validate_s0.py` stages init scripts to workspace with `0o644` file permissions before mounting.
- Removed `--rm` and poll TCP `127.0.0.1:5432` with premature exit detection and 5s heartbeats. Container cleanup is handled in `finally` via run-label match with `docker rm -f`.
- Serialized JSONB fields in `memory/run_embeddings.py` using `json.dumps`.

### 3. Isolated API Process Lifecycle & Search Validation

- `bin/validate_s0.py` binds a free loopback port via `socket.bind(('127.0.0.1', 0))`.
- Starts `uvicorn --app-dir docker/orchestrator main:app --host 127.0.0.1 --port <port>` with environment variables pointing exclusively to the disposable DB container and workspace task queue.
- Polls `http://127.0.0.1:<port>/health` with 5s heartbeats and process exit detection. On premature exit or timeout, logs are captured in evidence.
- Exercises `POST /memory/code-search/{project_id}` and `POST /memory/text-search/{project_id}` with known fixture queries and decoy project queries to verify project scoping.
- Terminates the API process and removes the disposable database in `finally`.

## Operator commands

From the root of `ai-orchestrator`, on branch `agent/s0-project-tracking-schema-parity`:

1. Run the deterministic regression tests (no Docker daemon or model weights required):
```bash
python -m py_compile bin/validate_s0.py tests/test_validate_s0.py docker/orchestrator/main.py memory/run_embeddings.py tests/test_run_embeddings_jsonb.py && PYTHONPATH=. python -m pytest -q tests/test_validate_s0.py tests/test_run_embeddings_jsonb.py
```

2. Preview dry-run:
```bash
python bin/validate_s0.py -s indexing -n -o "$(mktemp -d)/s0-preview"
```

3. Ensure Docker is running and `pgvector/pgvector:pg16` is cached:
```bash
docker pull pgvector/pgvector:pg16
```

4. Execute disposable database and search endpoint validation (with model downloads disabled):
```bash
python bin/validate_s0.py -s indexing -w -t 180
```

## Status and limits

- `PASS` requires a successful HTTP response (200 OK) with the expected fixture symbol/fact and verified decoy isolation (0 results for unrelated project).
- `FAIL` records a command, HTTP error, assertion failure, or scope leak.
- `BLOCKED` means a prerequisite, cached model, or explicit write flag is missing.
- `NOT_RUN` means the check is staged for a later S0 slice (`S0-REINDEX`, `S0-WORKER`, `S0-CHAT`, etc.).
- Offline model mode is enforced (`HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `HF_DATASETS_OFFLINE=1`).


