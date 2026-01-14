#!/bin/bash
# Local command worker
# Executes explicit command from task context (intended for host-side jobs).

set -euo pipefail

TASK_ID="${1:-}"
if [ -z "$TASK_ID" ]; then
    echo "Error: Task ID required" >&2
    exit 1
fi

TASK_QUEUE_PATH="${TASK_QUEUE_PATH:-$HOME/projects/ai-orchestrator/task_queue}"
TASK_FILE="$TASK_QUEUE_PATH/assigned/$TASK_ID.json"
RESULTS_DIR="$TASK_QUEUE_PATH/results/$TASK_ID"
TASK_TIMEOUT="${TASK_TIMEOUT:-7200}"

if [ ! -f "$TASK_FILE" ]; then
    echo "Error: Task file not found: $TASK_FILE" >&2
    exit 1
fi

mkdir -p "$RESULTS_DIR/artifacts"

mv "$TASK_FILE" "$TASK_QUEUE_PATH/in_progress/$TASK_ID.json" || {
    echo "Error: Failed to move task to in_progress" >&2
    exit 1
}

TASK_FILE="$TASK_QUEUE_PATH/in_progress/$TASK_ID.json"
TMP_FILE="${TASK_FILE}.tmp"

jq --arg pid "$$" --arg started "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
   '.worker_pid = ($pid | tonumber) | .started_at = $started' \
   "$TASK_FILE" > "$TMP_FILE" && mv "$TMP_FILE" "$TASK_FILE"

TASK_TITLE=$(jq -r '.task_title' "$TASK_FILE")
DESCRIPTION=$(jq -r '.description' "$TASK_FILE")
PROJECT_ID=$(jq -r '.project_id // "unknown"' "$TASK_FILE")
WORKING_DIR=$(jq -r '.working_dir // ""' "$TASK_FILE")
COMMAND=$(jq -r '.context.command // ""' "$TASK_FILE")

echo "[$(date +'%H:%M:%S')] Starting task: $TASK_TITLE" | tee -a "$RESULTS_DIR/stdout.log"
echo "[$(date +'%H:%M:%S')] Task ID: $TASK_ID" | tee -a "$RESULTS_DIR/stdout.log"
echo "[$(date +'%H:%M:%S')] Project ID: $PROJECT_ID" | tee -a "$RESULTS_DIR/stdout.log"

if [ -z "$COMMAND" ]; then
    echo "Error: No command provided in task context" | tee -a "$RESULTS_DIR/stderr.log"
    EXIT_CODE=2
else
    if [ -z "$WORKING_DIR" ] || [ ! -d "$WORKING_DIR" ]; then
        WORKING_DIR="$HOME"
    fi

    echo "[$(date +'%H:%M:%S')] Working directory: $WORKING_DIR" | tee -a "$RESULTS_DIR/stdout.log"
    echo "[$(date +'%H:%M:%S')] Timeout: ${TASK_TIMEOUT}s" | tee -a "$RESULTS_DIR/stdout.log"
    echo "[$(date +'%H:%M:%S')] Command: $COMMAND" | tee -a "$RESULTS_DIR/stdout.log"

    cd "$WORKING_DIR"
    START_TIME=$(date +%s)
    set +e
    timeout "$TASK_TIMEOUT" bash -lc "$COMMAND" \
        >> "$RESULTS_DIR/stdout.log" \
        2>> "$RESULTS_DIR/stderr.log"
    EXIT_CODE=$?
    set -e
    END_TIME=$(date +%s)
    DURATION=$((END_TIME - START_TIME))
fi

if [ -z "${DURATION:-}" ]; then
    DURATION=0
fi

if [ $EXIT_CODE -eq 0 ]; then
    SUMMARY="Task completed successfully"
elif [ $EXIT_CODE -eq 124 ]; then
    SUMMARY="Task timed out after ${TASK_TIMEOUT} seconds"
else
    SUMMARY="Task failed with exit code $EXIT_CODE"
fi

cat > "$RESULTS_DIR/output.txt" <<EOF
Task: $TASK_TITLE
Status: $([ $EXIT_CODE -eq 0 ] && echo "Completed" || echo "Failed")
Duration: ${DURATION} seconds
Exit Code: $EXIT_CODE

Summary:
$SUMMARY

Working Directory: $WORKING_DIR
Command: $COMMAND
EOF

if [ $EXIT_CODE -eq 0 ]; then
    jq --arg completed "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
       --argjson duration "$DURATION" \
       --arg output "$RESULTS_DIR/" \
       --arg summary "$SUMMARY" \
       '.completed_at = $completed |
        .duration_seconds = $duration |
        .result = {
          "success": true,
          "summary": $summary,
          "working_dir": "'"$WORKING_DIR"'"
        } |
        .output_path = $output' \
       "$TASK_FILE" > "$TMP_FILE" && mv "$TMP_FILE" "$TASK_FILE"

    mv "$TASK_FILE" "$TASK_QUEUE_PATH/completed/$TASK_ID.json"
    echo "[$(date +'%H:%M:%S')] ✓ Task completed successfully" | tee -a "$RESULTS_DIR/stdout.log"
else
    jq --arg failed "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
       --argjson exit_code "$EXIT_CODE" \
       --argjson duration "$DURATION" \
       --arg error_msg "$SUMMARY" \
       '.failed_at = $failed |
        .duration_seconds = $duration |
        .exit_code = $exit_code |
        .error = {
          "type": "ExecutionError",
          "message": $error_msg,
          "working_dir": "'"$WORKING_DIR"'"
        }' \
       "$TASK_FILE" > "$TMP_FILE" && mv "$TMP_FILE" "$TASK_FILE"

    mv "$TASK_FILE" "$TASK_QUEUE_PATH/failed/$TASK_ID.json"
    echo "[$(date +'%H:%M:%S')] ✗ Task failed: $SUMMARY" | tee -a "$RESULTS_DIR/stderr.log"
fi

exit $EXIT_CODE
