#!/usr/bin/env bash
#
# Build and start all dockerized services for the AI Orchestrator stack.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ -f "$REPO_ROOT/.env" ]; then
    set -a
    . "$REPO_ROOT/.env"
    set +a
fi

# The repo's .env is shell-oriented and may contain constructs that Docker
# Compose's stricter .env parser rejects. Source it in Bash, then point Compose
# at an empty env file so interpolation comes from the current process env.
COMPOSE_EMPTY_ENV="$(mktemp)"
trap 'rm -f "$COMPOSE_EMPTY_ENV"' EXIT

echo "==> Building containers (docker compose build)"
docker compose --env-file "$COMPOSE_EMPTY_ENV" build

echo "==> Starting services (docker compose up -d)"
docker compose --env-file "$COMPOSE_EMPTY_ENV" up -d --remove-orphans

echo "==> Current service status"
docker compose --env-file "$COMPOSE_EMPTY_ENV" ps

ORCH_PORT="${ORCHESTRATOR_PORT:-8000}"
KOWEB_PORT="${KO_WEB_PORT:-3001}"
CHAT_PORT="${KO_WEB_CHAT_PORT:-8765}"

echo ""
echo "==> Local endpoints"
echo "Orchestrator API: http://localhost:${ORCH_PORT}"
echo "Web UI (koweb):   http://localhost:${KOWEB_PORT}"
echo "Chat WS server:   ws://localhost:${CHAT_PORT}"
