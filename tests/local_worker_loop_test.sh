#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
loop_script="${WORKER_LOOP_SCRIPT:-$repo_root/bin/local_worker_loop.sh}"
tmp_root="$(mktemp -d)"
loop_pid=""

cleanup() {
    if [ -n "$loop_pid" ]; then
        kill "$loop_pid" 2>/dev/null || true
        wait "$loop_pid" 2>/dev/null || true
    fi
    rm -rf "$tmp_root"
}
trap cleanup EXIT

fail() {
    printf 'FAIL: %s\n' "$1" >&2
    exit 1
}

mkdir -p "$tmp_root/queue/assigned" "$tmp_root/queue/completed" "$tmp_root/queue/failed"
cat > "$tmp_root/mock-worker.sh" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail

task_id="$1"
task_queue_path="${TASK_QUEUE_PATH:?}"
case "$task_id" in
    a-fail)
        mv "$task_queue_path/assigned/$task_id.json" "$task_queue_path/failed/$task_id.json"
        exit 7
        ;;
    b-success)
        mv "$task_queue_path/assigned/$task_id.json" "$task_queue_path/completed/$task_id.json"
        exit 0
        ;;
    c-stuck)
        exit 9
        ;;
    *)
        exit 64
        ;;
esac
WORKER
chmod +x "$tmp_root/mock-worker.sh"

printf '{"cli_preference":"local"}\n' > "$tmp_root/queue/assigned/a-fail.json"
printf '{"cli_preference":"local"}\n' > "$tmp_root/queue/assigned/b-success.json"

TASK_QUEUE_PATH="$tmp_root/queue" \
WORKER_SCRIPT="$tmp_root/mock-worker.sh" \
POLL_INTERVAL=1 \
bash "$loop_script" > "$tmp_root/continue.log" 2>&1 &
loop_pid=$!

completed=false
for _ in {1..100}; do
    if [ -f "$tmp_root/queue/completed/b-success.json" ]; then
        completed=true
        break
    fi
    sleep 0.05
done

[ "$completed" = true ] || fail "worker loop did not process the task after a failed task"
[ -f "$tmp_root/queue/failed/a-fail.json" ] || fail "failed task was not recorded in failed/"
grep -q 'Task a-fail failed (exit 7); continuing' "$tmp_root/continue.log" || fail "worker loop did not report and continue after a recorded task failure"

kill "$loop_pid" 2>/dev/null || true
wait "$loop_pid" 2>/dev/null || true
loop_pid=""

printf '{"cli_preference":"local"}\n' > "$tmp_root/queue/assigned/c-stuck.json"
set +e
TASK_QUEUE_PATH="$tmp_root/queue" \
WORKER_SCRIPT="$tmp_root/mock-worker.sh" \
POLL_INTERVAL=1 \
bash "$loop_script" > "$tmp_root/stuck.log" 2>&1
status=$?
set -e

[ "$status" -eq 9 ] || fail "worker loop should surface the worker exit code when a task remains assigned (got $status)"
[ -f "$tmp_root/queue/assigned/c-stuck.json" ] || fail "test fixture should remain assigned for reconciliation"
grep -q 'still assigned and needs reconciliation' "$tmp_root/stuck.log" || fail "worker loop did not explain why it stopped"

printf 'PASS: recorded task failures do not stop later jobs; unclaimed tasks stop for reconciliation\n'
