#!/usr/bin/env bash
#
# Tear down all containers and rebuild/start everything.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

echo "==> Stopping all services (docker compose down --remove-orphans)"
docker compose down --remove-orphans

echo "==> Rebuilding and starting services"
"$REPO_ROOT/build_all.sh"
