---
name: project-context-brief
description: Write a stand-alone project context brief so another LLM can understand a codebase without direct repo access. Use when handing off implementation context, architecture, constraints, and current state.
---

# Project Context Brief

## Goal

Produce one document that gives another LLM enough technical context to reason about the project without reading the repository.

## Required Output

Create `rrnow/<project>-context-brief.md` with these sections:

1. Project identity
- name
- purpose
- runtime environment (OS, container/host split)

2. Current architecture
- major modules/services
- data flow
- state sources of truth

3. Contract surface
- core API endpoints
- DB schema entities that matter
- queue/event contracts

4. What works now
- verified working paths only
- include concrete evidence (file references, logs, or test outcomes)

5. What is broken / risky
- user-visible failures
- hidden operational hazards
- confidence level per claim

6. How to run and verify
- exact commands
- expected outputs
- rollback/safety notes

7. Open questions
- missing facts needed for high-confidence design decisions

## Rules

- Prefer code-grounded statements over doc-grounded statements.
- Include exact file references for important claims.
- Separate facts from inference using explicit labels: `Fact:` and `Inference:`.
- Keep prose dense and technical; avoid narrative filler.
