#!/bin/bash
# Claude Code CLI Worker
# Executes tasks from the task queue using Claude Code

set -euo pipefail

TASK_ID="${1:-}"
if [ -z "$TASK_ID" ]; then
    echo "Error: Task ID required" >&2
    exit 1
fi

# Configuration
TASK_QUEUE_PATH="${TASK_QUEUE_PATH:-/app/task_queue}"
TASK_FILE="$TASK_QUEUE_PATH/assigned/$TASK_ID.json"
RESULTS_DIR="$TASK_QUEUE_PATH/results/$TASK_ID"

# Check if task file exists
if [ ! -f "$TASK_FILE" ]; then
    echo "Error: Task file not found: $TASK_FILE" >&2
    exit 1
fi

# Create results directory
mkdir -p "$RESULTS_DIR/artifacts"

# Move task to in_progress
mv "$TASK_FILE" "$TASK_QUEUE_PATH/in_progress/$TASK_ID.json" || {
    echo "Error: Failed to move task to in_progress" >&2
    exit 1
}

# Update task with worker PID and started_at
TASK_FILE="$TASK_QUEUE_PATH/in_progress/$TASK_ID.json"
TMP_FILE="${TASK_FILE}.tmp"

jq --arg pid "$$" --arg started "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
   '.worker_pid = ($pid | tonumber) | .started_at = $started' \
   "$TASK_FILE" > "$TMP_FILE" && mv "$TMP_FILE" "$TASK_FILE"

# Extract task details
TASK_TITLE=$(jq -r '.task_title' "$TASK_FILE")
DESCRIPTION=$(jq -r '.description' "$TASK_FILE")
PROJECT_ID=$(jq -r '.project_id // "unknown"' "$TASK_FILE")

echo "[$(date +'%H:%M:%S')] Starting task: $TASK_TITLE" | tee -a "$RESULTS_DIR/stdout.log"
echo "[$(date +'%H:%M:%S')] Task ID: $TASK_ID" | tee -a "$RESULTS_DIR/stdout.log"
echo "[$(date +'%H:%M:%S')] Project ID: $PROJECT_ID" | tee -a "$RESULTS_DIR/stdout.log"

# Execute Claude Code CLI
# For now, simulate the work since claude CLI might not be available in container
echo "[$(date +'%H:%M:%S')] Executing with Claude Code..." | tee -a "$RESULTS_DIR/stdout.log"

# SIMULATION MODE (remove when real CLI is available)
sleep 3  # Simulate work
echo "[$(date +'%H:%M:%S')] Analyzing task requirements..." | tee -a "$RESULTS_DIR/stdout.log"
sleep 2
echo "[$(date +'%H:%M:%S')] Generating implementation..." | tee -a "$RESULTS_DIR/stdout.log"
sleep 3
echo "[$(date +'%H:%M:%S')] Running tests..." | tee -a "$RESULTS_DIR/stdout.log"
sleep 2
echo "[$(date +'%H:%M:%S')] Task completed successfully!" | tee -a "$RESULTS_DIR/stdout.log"

EXIT_CODE=0

# TODO: Real implementation
# claude --project "$PROJECT_ID" "$DESCRIPTION" \
#     > "$RESULTS_DIR/stdout.log" \
#     2> "$RESULTS_DIR/stderr.log"
# EXIT_CODE=$?

# Create summary
cat > "$RESULTS_DIR/output.txt" <<EOF
Task: $TASK_TITLE
Status: Completed (simulated)
Duration: 10 seconds

Summary:
- Analyzed task requirements
- Generated implementation
- All tests passed

This is a simulation. Real CLI integration pending.
EOF

# Move to appropriate final state
if [ $EXIT_CODE -eq 0 ]; then
    # Success - update and move to completed
    jq --arg completed "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
       --argjson duration 10 \
       --arg output "$RESULTS_DIR/" \
       '.completed_at = $completed |
        .duration_seconds = $duration |
        .result = {
          "success": true,
          "summary": "Task completed successfully (simulated)",
          "files_modified": 0
        } |
        .output_path = $output' \
       "$TASK_FILE" > "$TMP_FILE" && mv "$TMP_FILE" "$TASK_FILE"

    mv "$TASK_FILE" "$TASK_QUEUE_PATH/completed/$TASK_ID.json"
    echo "[$(date +'%H:%M:%S')] ✓ Task completed successfully" | tee -a "$RESULTS_DIR/stdout.log"
else
    # Failure - update and move to failed
    jq --arg failed "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
       --argjson exit_code "$EXIT_CODE" \
       --argjson duration 10 \
       '.failed_at = $failed |
        .duration_seconds = $duration |
        .exit_code = $exit_code |
        .error = {
          "type": "ExecutionError",
          "message": "CLI execution failed"
        }' \
       "$TASK_FILE" > "$TMP_FILE" && mv "$TMP_FILE" "$TASK_FILE"

    mv "$TASK_FILE" "$TASK_QUEUE_PATH/failed/$TASK_ID.json"
    echo "[$(date +'%H:%M:%S')] ✗ Task failed with exit code $EXIT_CODE" | tee -a "$RESULTS_DIR/stderr.log"
fi

exit $EXIT_CODE
