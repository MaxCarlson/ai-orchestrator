---
description: "Build/rebuild workflow and service parity"
applyTo: "**"
---

# Build and Rebuild Discipline

- Preferred entrypoints:
  - Full build/start: `./build_all.sh` (runs `docker compose build --pull` then `docker compose up -d`).
  - Rebuild after changes: `./rebuild.sh` (calls stop.sh then start.sh) to ensure clean restart.
  - Start-only: `./start.sh` (build --pull, up -d, then `./lms_bridge/bridge.sh start` when present).
  - Stop: `./stop.sh` (docker compose down --remove-orphans, stops bridge if present).
  - Inspect stack: `./info.sh` (ps, ps -a, images head, volumes, networks).
- Keep parity: if you change docker-compose or add services/flags, mirror those changes inside the scripts above so the documented entrypoints stay accurate.
- Build verification:
  - After (re)build, run `docker compose ps` and `curl http://localhost:8000/health` for orchestrator; `curl -I http://localhost:3001` for koweb.
  - When modifying images, prefer `docker compose build --pull` to pick security updates.
- GUI verification: pair build with the web UI visual skill ([skills/web-ui-visual-debug/web-ui-visual-debug.md](../../skills/web-ui-visual-debug/web-ui-visual-debug.md)) to launch koweb, capture current screenshots, and optionally diff against `orchestrator_web_viewer/tests/reference_ui/*.png`.
- Testing tie-in: run `pytest -q` before and after changes; for UI-related changes, include or update reference images and visual smoke steps.
