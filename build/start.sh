#!/usr/bin/env bash
#
# Build (pull) and start all orchestrator services.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ -f "$REPO_ROOT/.env" ]; then
    set -a
    . "$REPO_ROOT/.env"
    set +a
fi

echo "==> Building containers (docker compose build --pull)"
docker compose build --pull

echo "==> Starting services (docker compose up -d)"
docker compose up -d

if [ -x "./lms_bridge/bridge.sh" ]; then
    ./lms_bridge/bridge.sh start
fi

echo "==> Current service status"
docker compose ps

ORCH_PORT="${ORCHESTRATOR_PORT:-8000}"
KOWEB_PORT="${KO_WEB_PORT:-3001}"

echo ""
echo "==> Local endpoints"
echo "Orchestrator API: http://localhost:${ORCH_PORT}"
echo "Web UI (koweb): http://localhost:${KOWEB_PORT}"
