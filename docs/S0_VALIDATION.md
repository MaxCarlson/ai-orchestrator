# S0 validator: disposable direct indexing smoke

This is the first S0.1 slice. `bin/validate_s0.py` checks host prerequisites, then (with `--write`) runs the existing `memory.run_embeddings` entrypoint against a generated Python and Markdown fixture in a **new, run-owned PostgreSQL container**. It checks the resulting rows for the expected Python symbol, 768-dimensional vector and document fact. It does not start the existing Compose stack or use its `docker_postgres_data` external volume. It does not call `/memory/code-index/{project_id}`, which currently places a database password in a task command. Search endpoints, queue, chat, history and reindex remain `NOT_RUN`; a direct insert is not an API or worker proof.

## Operator commands

From the root of `ai-orchestrator`, on `agent/ai-assistant-architecture-roadmap`, run each command in order:

```bash
git pull --ff-only origin agent/ai-assistant-architecture-roadmap
python bin/validate_s0.py -s indexing -n -o "$(mktemp -d)/s0-preview"
```

Preview writes only the report files. A preview with indexing selected returns exit 2 because live checks are blocked by default; inspect the printed report path and `report.json`. Before live validation, have Docker running, the locally cached `pgvector/pgvector:pg16` image, an environment with the Python dependencies from `pyproject.toml`, and cached `microsoft/codebert-base` and `BAAI/bge-base-en-v1.5` model weights. The validator does not install or download them. To fetch the database image yourself if needed:

```bash
docker pull pgvector/pgvector:pg16
```

Once the prerequisites are present, execute the disposable direct check (the output directory must be unique per run; the default generates a unique directory):

```bash
python bin/validate_s0.py -s indexing -w -t 180
```

Share `report.json` and `report.md` from the printed output path, and report whether a model cache miss or dependency installation is needed. The run uses one new Docker container named `aioc-s0-<run-id>`, tagged with `ai-orchestrator-s0=<run-id>`, ephemeral storage, a random loopback host port and a randomly generated password passed by a temporary private environment file. It inserts a generated project and fixture only in that container. On normal completion it checks the ownership tag before stopping its container. Keep reports private until checked: bounded process logs can include incidental machine paths or error details. If interrupted before cleanup, identify only the uniquely labelled container from the report run ID and inspect it before stopping; do not prune volumes or containers globally.

## Status and limits

- `PASS` requires a successful subprocess and a specific row assertion; `FAIL` records a command or row assertion that executed and failed; `BLOCKED` means a prerequisite or explicit write flag is missing; `NOT_RUN` means the check is staged or unselected.
- Exit 0 means all selected required checks passed, exit 1 means at least one executed check failed, and exit 2 means there are blockers and no executed failures. `argparse` also uses exit 2 for invalid options.
- Reports include timestamps, repository branch/commit/dirty bit, Python/platform, safe command arguments, bounded redacted logs, status, fixture project ID and DB extension version when available. Credential values are omitted.
- Offline model mode is enforced (`HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `HF_DATASETS_OFFLINE=1`). A missing cached model is `BLOCKED`; other indexing failures are `FAIL` and need the logged reproduction investigated. A cached model can still be incompatible with the fixed vector(768) schema; that is a real failed assertion.
- Direct code and document checks are ordered. The indexer currently scans all files, so this fixture has only two tiny files. This step does not establish ignore handling, deletion reconciliation, model replacement, API search ranking or integration with the host worker.

Follow up after the first report: repair the smallest observed failure, then extend this validator with an isolated API, search/reindex assertions, queue, real LM Studio chat and persistence replay. The full acceptance criteria are in `docs/plans/20260926_ai-assistant/02_execution-plan-and-validation.md`.
