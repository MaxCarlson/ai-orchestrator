#!/usr/bin/env bash
#
# Build (pull) and start all orchestrator services.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

echo "==> Building containers (docker compose build --pull)"
docker compose build --pull

echo "==> Starting services (docker compose up -d)"
docker compose up -d

echo "==> Current service status"
docker compose ps
