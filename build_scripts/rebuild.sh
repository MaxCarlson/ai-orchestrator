#!/usr/bin/env bash
#
# Tear down all containers and rebuild/start everything.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

"$REPO_ROOT/stop.sh"
"$REPO_ROOT/start.sh"
