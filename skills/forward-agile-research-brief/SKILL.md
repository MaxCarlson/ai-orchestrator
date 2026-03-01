---
name: forward-agile-research-brief
description: Produce a research-oriented state-and-direction brief for external LLMs evaluating algorithms, frameworks, databases, and architecture choices.
---

# Forward Agile Research Brief

## Goal

Write a brief that enables research LLMs to evaluate `x vs y` technical choices with enough context to be useful and comparable.

## Required Output

Create `rrnow/forward-agile-development.md` with these sections:

1. Human goals and constraints
- explicit goals
- non-goals
- budget/time constraints
- operator preferences and guardrails

2. System baseline
- current architecture snapshot
- known bottlenecks
- operational pain points

3. Decision backlog
- each decision as a question (`Should we use A or B for C?`)
- decision owner
- urgency (`now`, `next`, `later`)

4. Evaluation rubric
- measurable criteria (latency, reliability, dev speed, cost, complexity)
- required evidence type for acceptance

5. Candidate analysis template
- option summary
- migration effort
- compatibility risks
- rollback strategy

6. Recommended experiments
- smallest useful experiment per decision
- pass/fail criteria
- instrumentation needed

7. Decision protocol
- who can propose
- who can approve
- what evidence is mandatory before plan adoption

## Rules

- Convert vague goals into decision questions.
- Do not propose rewrites without migration and rollback plans.
- Rank decisions by leverage and reversibility.
- Keep every recommendation testable.
