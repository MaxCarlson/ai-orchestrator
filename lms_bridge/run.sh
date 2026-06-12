#!/usr/bin/env bash
#
# Run LM Studio bridge on host (WSL).

set -euo pipefail

# PYTHONPATH in this environment includes pyenv site-packages which can poison
# the bridge's isolated venv. Unset it so the venv packages are used cleanly.
unset PYTHONPATH PYTHONHOME PYTHONSTARTUP 2>/dev/null || true

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

# Resolve lms binary: prefer native Linux install, fall back to WSL2 Windows-side paths.
if [ -z "${LMS_BINARY:-}" ]; then
    if command -v lms >/dev/null 2>&1; then
        LMS_BINARY="lms"
    elif [ -x "$HOME/.lmstudio/bin/lms" ]; then
        LMS_BINARY="$HOME/.lmstudio/bin/lms"
    else
        # Legacy WSL2 Windows-side fallback
        for _candidate in \
            "/mnt/c/Users/$USER/.lmstudio/bin/lms.exe" \
            /mnt/c/Users/*/.lmstudio/bin/lms.exe \
            "/mnt/c/Program Files/LM-Studio/bin/lms.exe"
        do
            if [ -x "$_candidate" ]; then
                LMS_BINARY="$_candidate"
                break
            fi
        done
    fi
fi
export LMS_BINARY="${LMS_BINARY:-lms}"

exec "$VENV_PY" -m uvicorn app:app --host 0.0.0.0 --port 5080
