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
TASK_QUEUE_PATH="${TASK_QUEUE_PATH:-$HOME/projects/ai-orchestrator/task_queue}"
TASK_FILE="$TASK_QUEUE_PATH/assigned/$TASK_ID.json"
RESULTS_DIR="$TASK_QUEUE_PATH/results/$TASK_ID"
TASK_TIMEOUT="${TASK_TIMEOUT:-1800}"  # 30 minutes default timeout

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
WORKING_DIR=$(jq -r '.working_dir // ""' "$TASK_FILE")

echo "[$(date +'%H:%M:%S')] Starting task: $TASK_TITLE" | tee -a "$RESULTS_DIR/stdout.log"
echo "[$(date +'%H:%M:%S')] Task ID: $TASK_ID" | tee -a "$RESULTS_DIR/stdout.log"
echo "[$(date +'%H:%M:%S')] Project ID: $PROJECT_ID" | tee -a "$RESULTS_DIR/stdout.log"

# Determine working directory
if [ -z "$WORKING_DIR" ] || [ ! -d "$WORKING_DIR" ]; then
    # Default to scripts repo if no working dir specified
    WORKING_DIR="$HOME/scripts"
fi

echo "[$(date +'%H:%M:%S')] Working directory: $WORKING_DIR" | tee -a "$RESULTS_DIR/stdout.log"
echo "[$(date +'%H:%M:%S')] Timeout: ${TASK_TIMEOUT}s" | tee -a "$RESULTS_DIR/stdout.log"

# Save pre-execution snapshot of directory (for detecting modified files)
cd "$WORKING_DIR"
find . -type f -newer "$TASK_FILE" > "$RESULTS_DIR/files_before.txt" 2>/dev/null || true

# Record start time for accurate duration
START_TIME=$(date +%s)

# Execute Claude Code CLI with timeout
echo "[$(date +'%H:%M:%S')] Executing with Claude Code..." | tee -a "$RESULTS_DIR/stdout.log"
echo "" | tee -a "$RESULTS_DIR/stdout.log"

# Check if claude command is available
if ! command -v claude &> /dev/null; then
    echo "Error: 'claude' command not found in PATH" | tee -a "$RESULTS_DIR/stderr.log"
    echo "Please install Claude Code CLI first" | tee -a "$RESULTS_DIR/stderr.log"
    EXIT_CODE=127
else
    # Execute with timeout
    set +e  # Don't exit on error
    timeout "$TASK_TIMEOUT" claude "$DESCRIPTION" \
        >> "$RESULTS_DIR/stdout.log" \
        2>> "$RESULTS_DIR/stderr.log"
    EXIT_CODE=$?
    set -e

    # Check if timed out
    if [ $EXIT_CODE -eq 124 ]; then
        echo "" | tee -a "$RESULTS_DIR/stderr.log"
        echo "[$(date +'%H:%M:%S')] ✗ Task timed out after ${TASK_TIMEOUT}s" | tee -a "$RESULTS_DIR/stderr.log"
    fi
fi

# Calculate duration
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo "" | tee -a "$RESULTS_DIR/stdout.log"
echo "[$(date +'%H:%M:%S')] Execution finished (exit code: $EXIT_CODE, duration: ${DURATION}s)" | tee -a "$RESULTS_DIR/stdout.log"

# Detect modified files
find . -type f -newer "$TASK_FILE" > "$RESULTS_DIR/files_after.txt" 2>/dev/null || true
comm -13 <(sort "$RESULTS_DIR/files_before.txt") <(sort "$RESULTS_DIR/files_after.txt") > "$RESULTS_DIR/files_modified.txt"
FILES_MODIFIED=$(wc -l < "$RESULTS_DIR/files_modified.txt")

# Copy modified files to artifacts directory
if [ "$FILES_MODIFIED" -gt 0 ]; then
    echo "[$(date +'%H:%M:%S')] Copying $FILES_MODIFIED modified file(s) to artifacts..." | tee -a "$RESULTS_DIR/stdout.log"
    while IFS= read -r file; do
        if [ -f "$file" ]; then
            # Preserve directory structure
            mkdir -p "$RESULTS_DIR/artifacts/$(dirname "$file")"
            cp "$file" "$RESULTS_DIR/artifacts/$file"
        fi
    done < "$RESULTS_DIR/files_modified.txt"
fi

# Create summary
if [ $EXIT_CODE -eq 0 ]; then
    SUMMARY="Task completed successfully"
elif [ $EXIT_CODE -eq 124 ]; then
    SUMMARY="Task timed out after ${TASK_TIMEOUT} seconds"
elif [ $EXIT_CODE -eq 127 ]; then
    SUMMARY="Claude Code CLI not found"
else
    SUMMARY="Task failed with exit code $EXIT_CODE"
fi

cat > "$RESULTS_DIR/output.txt" <<EOF
Task: $TASK_TITLE
Status: $([ $EXIT_CODE -eq 0 ] && echo "Completed" || echo "Failed")
Duration: ${DURATION} seconds
Exit Code: $EXIT_CODE
Files Modified: $FILES_MODIFIED

Summary:
$SUMMARY

Working Directory: $WORKING_DIR

$(if [ $EXIT_CODE -eq 0 ] && [ "$FILES_MODIFIED" -gt 0 ]; then
    echo "Modified Files:"
    cat "$RESULTS_DIR/files_modified.txt"
fi)

$(if [ -s "$RESULTS_DIR/stderr.log" ]; then
    echo ""
    echo "Errors/Warnings:"
    tail -20 "$RESULTS_DIR/stderr.log"
fi)
EOF

# Move to appropriate final state
if [ $EXIT_CODE -eq 0 ]; then
    # Success - update and move to completed
    jq --arg completed "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
       --argjson duration "$DURATION" \
       --arg output "$RESULTS_DIR/" \
       --arg summary "$SUMMARY" \
       --argjson files_modified "$FILES_MODIFIED" \
       '.completed_at = $completed |
        .duration_seconds = $duration |
        .result = {
          "success": true,
          "summary": $summary,
          "files_modified": $files_modified,
          "working_dir": "'"$WORKING_DIR"'"
        } |
        .output_path = $output' \
       "$TASK_FILE" > "$TMP_FILE" && mv "$TMP_FILE" "$TASK_FILE"

    mv "$TASK_FILE" "$TASK_QUEUE_PATH/completed/$TASK_ID.json"
    echo "[$(date +'%H:%M:%S')] ✓ Task completed successfully" | tee -a "$RESULTS_DIR/stdout.log"
else
    # Failure - update and move to failed
    ERROR_TYPE="ExecutionError"
    ERROR_MSG="$SUMMARY"

    if [ $EXIT_CODE -eq 124 ]; then
        ERROR_TYPE="TimeoutError"
    elif [ $EXIT_CODE -eq 127 ]; then
        ERROR_TYPE="CommandNotFoundError"
    fi

    jq --arg failed "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
       --argjson exit_code "$EXIT_CODE" \
       --argjson duration "$DURATION" \
       --arg error_type "$ERROR_TYPE" \
       --arg error_msg "$ERROR_MSG" \
       '.failed_at = $failed |
        .duration_seconds = $duration |
        .exit_code = $exit_code |
        .error = {
          "type": $error_type,
          "message": $error_msg,
          "working_dir": "'"$WORKING_DIR"'"
        }' \
       "$TASK_FILE" > "$TMP_FILE" && mv "$TMP_FILE" "$TASK_FILE"

    mv "$TASK_FILE" "$TASK_QUEUE_PATH/failed/$TASK_ID.json"
    echo "[$(date +'%H:%M:%S')] ✗ Task failed: $ERROR_MSG" | tee -a "$RESULTS_DIR/stderr.log"
fi

exit $EXIT_CODE
