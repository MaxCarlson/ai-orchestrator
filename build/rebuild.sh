#!/usr/bin/env bash
#
# Tear down all containers and rebuild/start everything.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$REPO_ROOT/build_scripts"
cd "$REPO_ROOT"

"$SCRIPT_DIR/stop.sh"
"$SCRIPT_DIR/start.sh"
