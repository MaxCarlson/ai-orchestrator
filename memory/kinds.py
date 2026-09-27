"""Closed taxonomy for approved durable memories."""

from __future__ import annotations

MEMORY_KINDS = frozenset(
    {
        "constraint",
        "preference",
        "decision",
        "project_fact",
        "code_note",
        "bug_note",
        "session_summary",
        "open_question",
    }
)

DEFAULT_MEMORY_KIND = "project_fact"


def validate_memory_kind(kind: str) -> str:
    normalized = kind.strip()
    if normalized not in MEMORY_KINDS:
        allowed = ", ".join(sorted(MEMORY_KINDS))
        raise ValueError(f"Invalid memory kind '{kind}'. Allowed kinds: {allowed}")
    return normalized
