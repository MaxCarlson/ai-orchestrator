#!/bin/bash

set -euo pipefail

TASK_QUEUE_PATH="${TASK_QUEUE_PATH:-$HOME/projects/ai-orchestrator/task_queue}"
WORKER_SCRIPT="${WORKER_SCRIPT:-$HOME/projects/ai-orchestrator/cli_integrations/local_worker.sh}"
POLL_INTERVAL="${POLL_INTERVAL:-2}"

if [ ! -x "$WORKER_SCRIPT" ]; then
    echo "Error: local worker script not executable: $WORKER_SCRIPT" >&2
    exit 1
fi

echo "[local-worker] Watching $TASK_QUEUE_PATH/assigned for local tasks..."

while true; do
    found=false
    for task_file in "$TASK_QUEUE_PATH/assigned"/*.json; do
        if [ ! -e "$task_file" ]; then
            break
        fi
        if jq -e '.cli_preference == "local"' "$task_file" >/dev/null 2>&1; then
            task_id="$(basename "$task_file" .json)"
            if [ -e "$TASK_QUEUE_PATH/in_progress/$task_id.json" ]; then
                echo "[local-worker] Skipping $task_id (already in_progress)"
                continue
            fi
            echo "[local-worker] Running task $task_id"
            if "$WORKER_SCRIPT" "$task_id"; then
                :
            else
                worker_exit=$?
                if [ -e "$task_file" ]; then
                    echo "[local-worker] Worker failed for $task_id (exit $worker_exit); task is still assigned and needs reconciliation" >&2
                    exit "$worker_exit"
                fi
                echo "[local-worker] Task $task_id failed (exit $worker_exit); continuing with remaining tasks" >&2
            fi
            found=true
        fi
    done
    if [ "$found" = false ]; then
        sleep "$POLL_INTERVAL"
    fi
done
