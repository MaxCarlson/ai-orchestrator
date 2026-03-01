---
name: critique-synthesis-plan
description: Create a critique-first review document where multiple LLM positions are compared and synthesized into one winning recommendation for the project plan.
---

# Critique Synthesis Plan

## Goal

Generate a document that collects competing LLM critiques, scores them, and selects one best recommendation per topic.

## Required Output

Create `rrnow/llm-critique-synthesis.md` with these sections:

1. Topics under review
- architecture
- reliability/safety
- UI/UX
- data model
- orchestration policy

2. Candidate positions
For each topic include:
- Position ID
- source LLM
- core claim
- required assumptions
- supporting evidence

3. Critique matrix
For each position score (1-5):
- correctness
- feasibility
- implementation risk
- observability impact
- reversibility

4. Winner selection
For each topic:
- winning position
- why it won
- what evidence would overturn it

5. Plan patch
- exact changes to apply to current plan docs
- tasks to implement winner
- validation checks before merge

## Rules

- Findings and critiques come before summaries.
- Every score must cite evidence or clearly marked inference.
- No blended compromise unless winner criteria explicitly tie.
- If evidence is insufficient, outcome is `defer`, not forced selection.
