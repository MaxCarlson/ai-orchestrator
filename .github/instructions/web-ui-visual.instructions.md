---
description: "Visual QA conventions for koweb and related frontends"
applyTo: "orchestrator_web_viewer/**"
---

# Web UI Visual Conventions

- Use the web-ui-visual-debug skill ([skills/web-ui-visual-debug/SKILL.md](../../skills/web-ui-visual-debug/SKILL.md)) whenever a change could affect layout, styling, or assets.
- Serve from the documented entrypoint: `docker compose up -d koweb` (or `koweb -p 3001 -r -v`) before inspecting pages.
- Prefer live inspection via the Simple Browser (`open_simple_browser` tool) and capture screenshots under `task_queue/results/<task-id>/artifacts/` when verifying fixes.
- After HTML/CSS/static changes, rebuild then restart koweb to pick up assets: `docker compose build koweb && docker compose up -d koweb`.
- When reporting issues, include: URL, viewport, screenshot path, and console/network errors if visible.
