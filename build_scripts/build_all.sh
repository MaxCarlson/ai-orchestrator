#!/usr/bin/env bash
#
# Build and start all dockerized services for the AI Orchestrator stack.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

echo "==> Building containers (docker compose build --pull)"
docker compose build --pull

echo "==> Starting services (docker compose up -d)"
docker compose up -d

echo "==> Current service status"
docker compose ps
