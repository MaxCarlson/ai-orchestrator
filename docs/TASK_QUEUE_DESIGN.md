# Task Queue System Design

**Created**: 2025-12-29
**Status**: Design Phase
**Purpose**: Filesystem-based task queue for AI CLI coordination

---

## Overview

The task queue system enables coordination between:
- **kmtui** (task submission)
- **Orchestrator** (task management and assignment)
- **AI CLIs** (task execution: claude, codex, gemini)

**Key Requirements**:
- Simple filesystem-based queue (no additional dependencies)
- Atomic operations (no race conditions)
- Task lifecycle tracking (queued → in-progress → completed/failed)
- Support for multiple concurrent workers
- Shared volume accessible from Docker and host

---

## Directory Structure

```
task_queue/
├── queued/              # New tasks waiting for assignment
│   └── <task-uuid>.json
├── assigned/            # Tasks assigned to CLI workers
│   └── <task-uuid>.json
├── in_progress/         # Tasks actively being worked on
│   └── <task-uuid>.json
├── completed/           # Successfully completed tasks
│   └── <task-uuid>.json
├── failed/              # Failed tasks with error info
│   └── <task-uuid>.json
└── results/             # Task results and artifacts
    └── <task-uuid>/
        ├── output.txt   # Primary output
        ├── stdout.log   # CLI stdout
        ├── stderr.log   # CLI stderr
        └── artifacts/   # Additional files
```

**Design Rationale**:
- Separate directories = clear state visualization
- UUID filenames = unique, sortable, collision-resistant
- Results directory = keeps artifacts separate from task metadata

---

## Task File Format

### Task Definition (JSON)

```json
{
  "task_id": "550e8400-e29b-41d4-a716-446655440000",
  "project_id": "uuid-of-project",
  "task_title": "Implement user authentication",
  "description": "Add JWT-based authentication to the API",
  "priority": 3,
  "cli_preference": "claude",
  "created_at": "2025-12-29T05:30:00Z",
  "created_by": "kmtui",
  "status": "queued",
  "context": {
    "project_name": "ai-orchestrator",
    "related_files": ["/path/to/file1.py", "/path/to/file2.py"],
    "dependencies": [],
    "tags": ["backend", "security"]
  },
  "constraints": {
    "max_duration_seconds": 3600,
    "require_human_approval": false,
    "timeout_action": "fail"
  }
}
```

### Task Metadata (after assignment)

When task moves to `assigned/` or `in_progress/`, additional fields:

```json
{
  // ... all fields from above ...
  "assigned_at": "2025-12-29T05:31:00Z",
  "assigned_to": "claude-code",
  "worker_pid": 12345,
  "started_at": "2025-12-29T05:31:05Z",
  "heartbeat_at": "2025-12-29T05:35:00Z"
}
```

### Task Result (in completed/)

```json
{
  // ... all fields from above ...
  "completed_at": "2025-12-29T05:45:00Z",
  "duration_seconds": 840,
  "exit_code": 0,
  "result": {
    "success": true,
    "summary": "Implemented JWT authentication with refresh tokens",
    "changes": [
      "Created auth/jwt.py with token generation",
      "Added /api/auth/login endpoint",
      "Updated user model with password hashing"
    ],
    "tests_passed": true,
    "files_modified": 5,
    "lines_added": 234,
    "lines_removed": 12
  },
  "output_path": "results/550e8400-e29b-41d4-a716-446655440000/"
}
```

### Failed Task (in failed/)

```json
{
  // ... all fields from above ...
  "failed_at": "2025-12-29T05:45:00Z",
  "duration_seconds": 120,
  "exit_code": 1,
  "error": {
    "type": "TimeoutError",
    "message": "Task exceeded maximum duration of 3600 seconds",
    "traceback": "...",
    "recovery_action": "retry_with_extended_timeout"
  },
  "retry_count": 0,
  "max_retries": 3
}
```

---

## Task Lifecycle

```
┌─────────┐
│ kmtui   │ (creates task)
│ submits │
└────┬────┘
     │
     ▼
┌─────────────┐
│  queued/    │ ◄─── New tasks wait here
└─────┬───────┘
      │
      │ (orchestrator polls)
      ▼
┌─────────────┐
│ assigned/   │ ◄─── Orchestrator assigns to CLI worker
└─────┬───────┘
      │
      │ (CLI worker starts)
      ▼
┌─────────────┐
│in_progress/ │ ◄─── CLI actively working (heartbeat updates)
└─────┬───────┘
      │
      ├──► Success ──► completed/
      │
      └──► Failure ──► failed/ ──► (retry?) ──► queued/
```

**State Transitions**:
1. **queued** → **assigned**: Orchestrator assigns to available CLI
2. **assigned** → **in_progress**: CLI worker starts execution
3. **in_progress** → **completed**: CLI finishes successfully
4. **in_progress** → **failed**: CLI encounters error or timeout
5. **failed** → **queued**: Task eligible for retry (if max_retries not exceeded)

---

## Atomic Operations

### Task State Change (Atomic Move)

```python
import os
import shutil
import json
from pathlib import Path

def move_task_atomic(task_id: str, from_state: str, to_state: str,
                     updates: dict = None) -> bool:
    """Atomically move task between states with optional updates."""
    source = Path(f"task_queue/{from_state}/{task_id}.json")
    dest = Path(f"task_queue/{to_state}/{task_id}.json")

    if not source.exists():
        return False

    # Read current task
    with open(source, 'r') as f:
        task_data = json.load(f)

    # Apply updates
    if updates:
        task_data.update(updates)
        task_data['status'] = to_state

    # Write to temp file in destination directory
    temp_file = dest.with_suffix('.tmp')
    with open(temp_file, 'w') as f:
        json.dump(task_data, f, indent=2)

    # Atomic rename
    os.rename(temp_file, dest)

    # Remove original
    os.unlink(source)

    return True
```

**Why Atomic**:
- `os.rename()` is atomic on most filesystems
- Temp file ensures no partial writes
- Original removed only after successful move

---

## Integration Points

### 1. kmtui → Task Queue

**Trigger**: User presses 'a' (assign to AI) in kmtui

```python
def submit_task_to_queue(project_id: str, task_id: str,
                         task_title: str, description: str,
                         cli_preference: str = "claude"):
    """Submit task from kmtui to task queue."""
    task_data = {
        "task_id": task_id,
        "project_id": project_id,
        "task_title": task_title,
        "description": description,
        "priority": 3,
        "cli_preference": cli_preference,
        "created_at": datetime.utcnow().isoformat() + "Z",
        "created_by": "kmtui",
        "status": "queued",
        "context": {
            "project_name": get_project_name(project_id),
            "related_files": [],
            "dependencies": [],
            "tags": []
        },
        "constraints": {
            "max_duration_seconds": 3600,
            "require_human_approval": False,
            "timeout_action": "fail"
        }
    }

    queue_path = Path(os.getenv("TASK_QUEUE_PATH", "/app/task_queue"))
    task_file = queue_path / "queued" / f"{task_id}.json"

    with open(task_file, 'w') as f:
        json.dump(task_data, f, indent=2)

    print(f"✅ Task {task_id} submitted to queue")
```

### 2. Orchestrator → Task Assignment

**Polling Loop** (runs every 5 seconds):

```python
async def poll_and_assign_tasks():
    """Poll queued/ directory and assign tasks to available CLIs."""
    queue_path = Path(os.getenv("TASK_QUEUE_PATH", "/app/task_queue"))
    queued_dir = queue_path / "queued"

    while True:
        # Get all queued tasks
        tasks = sorted(queued_dir.glob("*.json"))

        for task_file in tasks:
            # Read task
            with open(task_file, 'r') as f:
                task_data = json.load(f)

            # Check available CLI workers
            available_cli = get_available_cli_worker(
                task_data.get("cli_preference", "claude")
            )

            if available_cli:
                # Assign task
                move_task_atomic(
                    task_data["task_id"],
                    "queued",
                    "assigned",
                    updates={
                        "assigned_at": datetime.utcnow().isoformat() + "Z",
                        "assigned_to": available_cli
                    }
                )

                # Spawn CLI worker
                spawn_cli_worker(available_cli, task_data)

        await asyncio.sleep(5)
```

### 3. CLI Worker → Task Execution

**Worker Wrapper**:

```bash
#!/bin/bash
# cli_integrations/claude_worker.sh

TASK_ID=$1
TASK_FILE="task_queue/assigned/${TASK_ID}.json"

# Read task details
DESCRIPTION=$(jq -r '.description' "$TASK_FILE")
PROJECT_ID=$(jq -r '.project_id' "$TASK_FILE")

# Move to in_progress
move_task "$TASK_ID" "assigned" "in_progress"

# Update task with worker info
jq '.started_at = now | .worker_pid = $pid' \
   --argjson pid $$ \
   "task_queue/in_progress/${TASK_ID}.json" > tmp && mv tmp "task_queue/in_progress/${TASK_ID}.json"

# Create results directory
mkdir -p "task_queue/results/${TASK_ID}/artifacts"

# Execute Claude Code
claude --project "$PROJECT_ID" "$DESCRIPTION" \
    > "task_queue/results/${TASK_ID}/stdout.log" \
    2> "task_queue/results/${TASK_ID}/stderr.log"

EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    # Success - move to completed
    move_task "$TASK_ID" "in_progress" "completed"
else
    # Failure - move to failed
    move_task "$TASK_ID" "in_progress" "failed"
fi
```

---

## Shared Volume Configuration

### docker-compose.yml

```yaml
volumes:
  task_queue:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /home/mcarls/projects/ai-orchestrator/task_queue
```

**Why Bind Mount**:
- Host CLIs can access queue directly
- Docker orchestrator can access same queue
- No volume permission issues

### Environment Variables

```bash
# In ~/.zshrc or kmtui shell function
export TASK_QUEUE_PATH="/home/mcarls/projects/ai-orchestrator/task_queue"

# In docker-compose.yml (orchestrator service)
environment:
  TASK_QUEUE_PATH: /app/task_queue
```

---

## Monitoring and Observability

### Task Queue Dashboard (Future)

**Metrics to Track**:
- Tasks in each state (queued, assigned, in_progress, completed, failed)
- Average task duration by CLI type
- Success/failure rate
- Queue depth over time
- CLI worker utilization

### Health Checks

```python
def check_queue_health():
    """Check for stuck tasks and stale workers."""
    now = datetime.utcnow()

    # Check for stale in_progress tasks (no heartbeat > 5 min)
    for task_file in Path("task_queue/in_progress").glob("*.json"):
        with open(task_file) as f:
            task = json.load(f)

        last_heartbeat = datetime.fromisoformat(
            task.get("heartbeat_at", task["started_at"]).replace("Z", "")
        )

        if (now - last_heartbeat).seconds > 300:
            # Task appears stuck - move to failed
            move_task_atomic(
                task["task_id"],
                "in_progress",
                "failed",
                updates={
                    "failed_at": now.isoformat() + "Z",
                    "error": {
                        "type": "StalledTask",
                        "message": "No heartbeat for >5 minutes"
                    }
                }
            )
```

---

## Security Considerations

1. **Task Validation**: Validate task JSON schema before processing
2. **Path Traversal**: Sanitize file paths in task context
3. **Resource Limits**: Enforce max_duration_seconds and memory limits
4. **Isolation**: Consider running CLI workers in sandboxes (Docker, firejail)
5. **Secrets**: Never store credentials in task files (use env vars)

---

## Next Steps

1. ✅ Design complete (this document)
2. [ ] Implement task queue manager module (`shared/task_queue.py`)
3. [ ] Add task submission to kmtui
4. [ ] Implement orchestrator polling logic
5. [ ] Create CLI wrapper scripts
6. [ ] Test end-to-end task flow

---

**End of Design Document**
