#!/usr/bin/env bash
#
# Run LM Studio bridge on host (WSL).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/lms_bridge"

PYTHON_BIN="${PYTHON_BIN:-/usr/bin/python3.11}"
if [ ! -x "$PYTHON_BIN" ]; then
    for candidate in /usr/bin/python3.12 /usr/bin/python3.11 /usr/bin/python3.10 /usr/bin/python3; do
        if [ -x "$candidate" ]; then
            PYTHON_BIN="$candidate"
            break
        fi
    done
fi

if [ ! -x "$PYTHON_BIN" ]; then
    echo "Python 3.10-3.12 is required. Install python3.12 or set PYTHON_BIN to a compatible binary." >&2
    exit 1
fi

if [ -d ".venv" ]; then
    VENV_PY=".venv/bin/python"
    if [ -x "$VENV_PY" ]; then
        VENV_VERSION="$("$VENV_PY" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
        TARGET_VERSION="$("$PYTHON_BIN" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
        if [ "$VENV_VERSION" != "$TARGET_VERSION" ]; then
            rm -rf .venv
        fi
    else
        rm -rf .venv
    fi
fi

"$PYTHON_BIN" -m venv .venv
VENV_PY=".venv/bin/python"
"$VENV_PY" -m pip install --upgrade pip
"$VENV_PY" -m pip install -r requirements.txt

export LMS_HOST="${LMS_HOST:-127.0.0.1}"
export LMS_PORT="${LMS_PORT:-1234}"
export LMS_BINARY="${LMS_BINARY:-lms.exe}"

exec "$VENV_PY" -m uvicorn app:app --host 0.0.0.0 --port 5080
