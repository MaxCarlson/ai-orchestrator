#!/usr/bin/env bash
#
# Stop and remove all orchestrator services.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Stopping services (docker compose down --remove-orphans)"
docker compose down --remove-orphans

if [ -x "./lms_bridge/bridge.sh" ]; then
    ./lms_bridge/bridge.sh stop
fi
