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

BUILD_PULL="${BUILD_PULL:-0}"
run_build() {
    if [ "$BUILD_PULL" = "1" ]; then
        docker compose build --pull
    else
        docker compose build
    fi
}

if [ "$BUILD_PULL" = "1" ]; then
    echo "==> Building containers (docker compose build --pull)"
else
    echo "==> Building containers (docker compose build)"
fi
set +e
BUILD_OUTPUT="$(run_build 2>&1)"
BUILD_STATUS=$?
set -e

if [ $BUILD_STATUS -ne 0 ]; then
    echo "$BUILD_OUTPUT"
    if echo "$BUILD_OUTPUT" | grep -q "A specified logon session does not exist"; then
        echo ""
        echo "==> Docker credential helper failed (desktop.exe logon session)."
        echo "==> Retrying build with temporary anonymous Docker config..."
        TMP_DOCKER_CONFIG="$(mktemp -d)"
        printf '{\"auths\":{}}' > "${TMP_DOCKER_CONFIG}/config.json"
        if [ "$BUILD_PULL" = "1" ]; then
            DOCKER_CONFIG="$TMP_DOCKER_CONFIG" docker compose build --pull
        else
            DOCKER_CONFIG="$TMP_DOCKER_CONFIG" docker compose build
        fi
        rm -rf "$TMP_DOCKER_CONFIG"
    else
        exit $BUILD_STATUS
    fi
fi

echo "==> Starting services (docker compose up -d)"
docker compose up -d

sleep 2
if ! docker compose ps --status running --services | grep -qx "koweb"; then
    echo "==> koweb is not running after startup; attempting one restart..."
    docker compose up -d koweb || true
    sleep 2
    if ! docker compose ps --status running --services | grep -qx "koweb"; then
        echo "==> koweb is still not running. Recent logs:"
        docker compose logs --tail=120 koweb || true
    fi
fi

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
