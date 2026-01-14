#!/usr/bin/env bash
#
# Run LM Studio bridge on host (WSL).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/lms_bridge"

python -m venv .venv
. .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

export LMS_HOST="${LMS_HOST:-127.0.0.1}"
export LMS_PORT="${LMS_PORT:-1234}"
export LMS_BINARY="${LMS_BINARY:-lms.exe}"

python -m uvicorn app:app --host 0.0.0.0 --port 5080
