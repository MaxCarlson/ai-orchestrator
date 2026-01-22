---
description: "Testing workflow and coverage expectations"
applyTo: "**/*.py"
---

# Testing Discipline

- Run tests before editing: `pytest -q` (or `pytest -q orchestrator_web_viewer/tests` when working in that module) to capture the current pass/fail baseline.
- Add tests with intent to reach 100% coverage for new/changed code; prefer focused pytest tests near the code under test (mirror module paths under tests/ or orchestrator_web_viewer/tests/).
- Re-run the same test set after changes with `pytest -q`; keep quiet mode to reduce token/log noise.
- If a previously passing test fails:
  - If CLI/behavior changed intentionally, update the test expectations rather than reverting the improved behavior.
  - If behavior should stay the same, fix the implementation instead of weakening the test.
- Include new tests for new features/bug fixes in the same change; avoid duplicating existing cases—extend parametrization or fixtures when possible.
- Keep fixtures fast and isolated; avoid network/DB unless necessary. Prefer small sample data under tests/fixtures/ and use dependency injection to bypass external calls.
- Record coverage gaps: if a line cannot be covered, justify with a comment and `# pragma: no cover` sparingly.
- Before declaring done, ensure all tests pass quietly and newly added files/folders live in the correct module locations.
