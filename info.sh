#!/usr/bin/env bash
#
# Show Docker and compose info for the AI Orchestrator stack.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

echo "==> docker compose ps"
docker compose ps || true

echo ""
echo "==> docker ps"
docker ps || true

echo ""
echo "==> docker images (top 20)"
docker images | head -n 21 || true

echo ""
echo "==> docker volumes"
docker volume ls || true

echo ""
echo "==> docker networks"
docker network ls || true
