#!/usr/bin/env bash
#
# Manage the LM Studio bridge as a background process.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_DIR="$ROOT_DIR/lms_bridge"
PID_FILE="$BRIDGE_DIR/.bridge.pid"
LOG_FILE="$ROOT_DIR/logs/lms_bridge.log"

mkdir -p "$ROOT_DIR/logs"

is_running() {
    if [ -f "$PID_FILE" ]; then
        local pid
        pid="$(cat "$PID_FILE")"
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
    fi
    return 1
}

start_bridge() {
    if is_running; then
        echo "LM Studio bridge already running (pid $(cat "$PID_FILE"))."
        return 0
    fi
    echo "==> Starting LM Studio bridge"
    (
        cd "$ROOT_DIR"
        nohup "$BRIDGE_DIR/run.sh" >"$LOG_FILE" 2>&1 &
        echo $! >"$PID_FILE"
    )
    sleep 0.5
    if is_running; then
        echo "LM Studio bridge started (pid $(cat "$PID_FILE"))."
    else
        echo "LM Studio bridge failed to start. See $LOG_FILE." >&2
        return 1
    fi
}

stop_bridge() {
    if ! is_running; then
        echo "LM Studio bridge not running."
        rm -f "$PID_FILE"
        return 0
    fi
    local pid
    pid="$(cat "$PID_FILE")"
    echo "==> Stopping LM Studio bridge (pid $pid)"
    kill "$pid" 2>/dev/null || true
    sleep 0.5
    if kill -0 "$pid" 2>/dev/null; then
        echo "LM Studio bridge still running; sending SIGKILL."
        kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
}

status_bridge() {
    if is_running; then
        echo "LM Studio bridge running (pid $(cat "$PID_FILE"))."
    else
        echo "LM Studio bridge not running."
        return 1
    fi
}

case "${1:-}" in
    start)
        start_bridge
        ;;
    stop)
        stop_bridge
        ;;
    restart)
        stop_bridge
        start_bridge
        ;;
    status)
        status_bridge
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status}" >&2
        exit 1
        ;;
esac
