---
name: web-ui-visual-debug
description: "Capture and inspect the live Koweb/web UI to spot visual regressions. Use when asked to 'see the page', 'take a screenshot', or validate layout/styles after rebuilds."
compatibility: "Requires docker compose, koweb CLI (pip install -e modules/orchestrator_web_viewer/[termdash]), and VS Code Simple Browser access."
---

# Web UI Visual Debug & Capture

## When to Use
- Need eyes-on validation of koweb or other served frontends after code changes.
- Capture before/after screenshots to confirm CSS/HTML fixes.
- Reproduce/report visual bugs with concrete artifacts.

## Prerequisites
- Services up: `docker compose up -d koweb` (or `koweb -p 3001 -r -v` from repo root).
- Environment: KO_WEB_* envs set; default port 3001. Task queue mounted if artifacts should land in task_queue/results/<task-id>/.
- Tools: VS Code Simple Browser (`open_simple_browser` tool here) to view the page; headless capture command if available (`chromium --headless --disable-gpu --screenshot=...`).

## Workflow

### 1) Start / verify the UI
1. From ai-orchestrator root: `docker compose up -d koweb`.
2. Sanity check: `curl -I http://localhost:3001` (expect 200/301) and watch logs with `docker compose logs -f koweb` if needed.

### 2) Open the live page
1. Use the `open_simple_browser` tool with `http://localhost:3001` (or custom KO_WEB_PORT).
2. Navigate within the browser to pages you touched (dashboard, results, TermDash, etc.).

### 3) Capture screenshots (choose one)
- Fast path (if Chromium present):
  - `chromium --headless --disable-gpu --screenshot=artifacts/webui.png http://localhost:3001` (adjust path/viewport with `--window-size=1280,720`).
- VS Code path:
  - Use the Simple Browser UI's capture action (camera icon/command palette) while on the target page; save under `task_queue/results/<task-id>/artifacts/` when relevant.
- Fallback:
  - `python - <<'PY'
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width":1280,"height":720})
    page.goto("http://localhost:3001", wait_until="networkidle")
    page.screenshot(path="artifacts/webui.png", full_page=True)
    b.close()
PY`
  - Requires `pip install playwright` once per environment.

### 4) Store and reference
- Drop captures in `task_queue/results/<task-id>/artifacts/` or a local `artifacts/` folder and cite paths in notes/PRs.
- If investigating a regression, keep both before/after captures with timestamps.

### 5) Automated visual smoke test (optional)
- Keep reference shots under `orchestrator_web_viewer/tests/reference_ui/` (e.g., `dashboard.png`).
- Rebuild and start: `docker compose build koweb && docker compose up -d koweb`.
- Capture current: `chromium --headless --disable-gpu --window-size=1280,720 --screenshot=artifacts/current.png http://localhost:3001`.
- Compare with a tiny Python diff (requires pillow):
  - `python - <<'PY'
from PIL import Image, ImageChops
ref = Image.open('orchestrator_web_viewer/tests/reference_ui/dashboard.png').convert('RGB')
cur = Image.open('artifacts/current.png').convert('RGB')
diff = ImageChops.difference(ref, cur)
box = diff.getbbox()
print('diff bbox:', box)
diff.save('artifacts/diff.png') if box else None
PY`
- Flag any non-empty bbox for review and attach diff.png.

## Tips
- Always rebuild/restart koweb after frontend/template changes: `docker compose build koweb && docker compose up -d koweb`.
- Use KO_WEB_AUTH_USER/KO_WEB_AUTH_PASSWORD when exposing beyond localhost.
- If port is busy, find the binder via `lsof -i :3001` and stop conflicting processes.
