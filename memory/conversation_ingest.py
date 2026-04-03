"""Conversation export normalization utilities."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any


ROLE_KEYS = ("role", "speaker", "author", "type")
CONTENT_KEYS = ("content", "text", "message", "value", "body")
TIMESTAMP_KEYS = ("timestamp", "created_at", "time", "date")


@dataclass(slots=True)
class NormalizedConversation:
    """Normalized conversation content ready for chunking."""

    title: str | None
    content: str
    metadata: dict[str, Any]


def _stringify_timestamp(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(value).isoformat()
        except Exception:
            return str(value)
    return str(value)


def _extract_value(payload: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        if key in payload and payload[key] not in (None, ""):
            return payload[key]
    return None


def _normalize_turn(turn: dict[str, Any], index: int) -> str:
    role = _extract_value(turn, ROLE_KEYS) or f"message_{index}"
    timestamp = _stringify_timestamp(_extract_value(turn, TIMESTAMP_KEYS))
    content = _extract_value(turn, CONTENT_KEYS)
    if isinstance(content, list):
        content = "\n".join(str(item) for item in content if item not in (None, ""))
    elif isinstance(content, dict):
        content = json.dumps(content, ensure_ascii=False, sort_keys=True)
    content = str(content or "").strip()
    lines = [f"[{str(role).upper()}]"]
    if timestamp:
        lines.append(f"Time: {timestamp}")
    lines.append(content)
    return "\n".join(lines).strip()


def _normalize_message_list(messages: list[dict[str, Any]], title: str | None = None) -> NormalizedConversation:
    body = [f"Conversation: {title}" if title else "Conversation Export", ""]
    for index, message in enumerate(messages, start=1):
        body.append(_normalize_turn(message, index))
        body.append("")
    content = "\n".join(line for line in body if line is not None).strip()
    return NormalizedConversation(
        title=title,
        content=content,
        metadata={"message_count": len(messages)},
    )


def _extract_messages(payload: Any) -> tuple[list[dict[str, Any]], str | None]:
    if isinstance(payload, list):
        messages = [item for item in payload if isinstance(item, dict)]
        return messages, None

    if not isinstance(payload, dict):
        raise ValueError("Conversation export must be a JSON object or array")

    title = payload.get("title") or payload.get("name")

    if isinstance(payload.get("messages"), list):
        return [item for item in payload["messages"] if isinstance(item, dict)], title

    if isinstance(payload.get("conversation"), list):
        return [item for item in payload["conversation"] if isinstance(item, dict)], title

    mapping = payload.get("mapping")
    if isinstance(mapping, dict):
        ordered: list[dict[str, Any]] = []
        for node in mapping.values():
            if not isinstance(node, dict):
                continue
            message = node.get("message") or node
            if not isinstance(message, dict):
                continue
            author = message.get("author")
            content = message.get("content")
            text = ""
            if isinstance(content, dict):
                parts = content.get("parts")
                if isinstance(parts, list):
                    text = "\n".join(str(part) for part in parts if part not in (None, ""))
            ordered.append(
                {
                    "role": (author or {}).get("role") if isinstance(author, dict) else message.get("role"),
                    "content": text or message.get("text") or message.get("content"),
                    "timestamp": message.get("create_time") or node.get("create_time"),
                }
            )
        return ordered, title

    raise ValueError("Unsupported conversation JSON format")


def normalize_conversation_text(text: str, title: str | None = None) -> NormalizedConversation:
    """Normalize a plain-text or markdown transcript."""
    stripped = text.strip()
    header = f"Conversation: {title}" if title else "Conversation Transcript"
    content = f"{header}\n\n{stripped}" if stripped else header
    return NormalizedConversation(
        title=title,
        content=content,
        metadata={"message_count": None},
    )


def normalize_conversation_json(text: str) -> NormalizedConversation:
    """Normalize JSON conversation exports."""
    payload = json.loads(text)
    messages, title = _extract_messages(payload)
    return _normalize_message_list(messages, title=title)


def normalize_conversation_ndjson(text: str) -> NormalizedConversation:
    """Normalize NDJSON conversation exports."""
    messages: list[dict[str, Any]] = []
    title: str | None = None
    for line in text.splitlines():
        if not line.strip():
            continue
        payload = json.loads(line)
        if isinstance(payload, dict):
            title = title or payload.get("title") or payload.get("name")
            messages.append(payload)
    return _normalize_message_list(messages, title=title)


def normalize_conversation_content(text: str, fmt: str | None = None) -> NormalizedConversation:
    """Normalize conversation content based on an explicit or inferred format."""
    format_hint = (fmt or "").strip().lower()
    if format_hint == "ndjson":
        return normalize_conversation_ndjson(text)
    if format_hint == "json":
        return normalize_conversation_json(text)
    if format_hint in {"txt", "text", "md", "markdown"}:
        return normalize_conversation_text(text)

    stripped = text.lstrip()
    if stripped.startswith("{") or stripped.startswith("["):
        return normalize_conversation_json(text)
    if any(line.strip().startswith("{") for line in text.splitlines()[:5]):
        try:
            return normalize_conversation_ndjson(text)
        except Exception:
            pass
    return normalize_conversation_text(text)
