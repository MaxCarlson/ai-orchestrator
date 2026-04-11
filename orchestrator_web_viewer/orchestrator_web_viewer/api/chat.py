"""WebSocket proxy and model list for the TypeScript chat agent server."""
import asyncio
import json
import logging
import os
from typing import Any

import httpx
import websockets
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

log = logging.getLogger(__name__)

router = APIRouter(tags=["chat"])

CHAT_SERVER_URL = os.getenv("KO_WEB_CHAT_SERVER_URL", "ws://localhost:8765")
LM_STUDIO_URL   = "http://{}:{}".format(
    os.getenv("KO_WEB_LMSTUDIO_HOST", "localhost"),
    os.getenv("KO_WEB_LMSTUDIO_PORT", "1234"),
)

# ── Static model registry ─────────────────────────────────────────────────────
# These are always shown regardless of what is running locally.

_CLI_MODELS = [
    {"id": "@claude",  "label": "claude (CLI)",  "group": "CLI Tools"},
    {"id": "@gemini",  "label": "gemini (CLI)",  "group": "CLI Tools"},
    {"id": "@codex",   "label": "codex (CLI)",   "group": "CLI Tools"},
    {"id": "@copilot", "label": "copilot (CLI)", "group": "CLI Tools"},
]

_API_MODELS = [
    {"id": "claude-opus-4-6",          "label": "claude-opus-4-6",    "group": "Anthropic API"},
    {"id": "claude-sonnet-4-6",        "label": "claude-sonnet-4-6",  "group": "Anthropic API"},
    {"id": "claude-haiku-4-5-20251001","label": "claude-haiku-4-5",   "group": "Anthropic API"},
    {"id": "gemini-2.5-pro",           "label": "gemini-2.5-pro",     "group": "Google API"},
    {"id": "gemini-2.5-flash",         "label": "gemini-2.5-flash",   "group": "Google API"},
    {"id": "gemini-2.0-flash",         "label": "gemini-2.0-flash",   "group": "Google API"},
    {"id": "gpt-4o",                   "label": "gpt-4o",             "group": "OpenAI API"},
    {"id": "gpt-4o-mini",              "label": "gpt-4o-mini",        "group": "OpenAI API"},
    {"id": "o3",                       "label": "o3",                 "group": "OpenAI API"},
    {"id": "o1",                       "label": "o1",                 "group": "OpenAI API"},
]


async def _fetch_lmstudio_models() -> list[dict[str, Any]]:
    """Query LM Studio's OpenAI-compat /v1/models endpoint for loaded models."""
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(f"{LM_STUDIO_URL}/v1/models")
            resp.raise_for_status()
            data = resp.json()
            models = []
            for m in data.get("data", []):
                model_id = m.get("id", "")
                if model_id:
                    models.append({
                        "id": model_id,
                        "label": model_id,
                        "group": "Local (LM Studio)",
                    })
            return models
    except Exception as exc:
        log.debug("LM Studio not reachable: %s", exc)
        return []


@router.get("/api/chat/models")
async def list_chat_models() -> dict[str, Any]:
    """Return all available chat models, including live LM Studio models."""
    local_models = await _fetch_lmstudio_models()
    return {
        "models": _CLI_MODELS + local_models + _API_MODELS,
    }


# ── WebSocket proxy ───────────────────────────────────────────────────────────

@router.websocket("/ws/chat")
async def chat_proxy(client_ws: WebSocket) -> None:
    """Proxy WebSocket connections transparently to the TypeScript chat server."""
    await client_ws.accept()
    log.info("Chat WebSocket client connected")
    try:
        async with websockets.connect(CHAT_SERVER_URL) as server_ws:
            async def client_to_server() -> None:
                try:
                    while True:
                        data = await client_ws.receive_text()
                        await server_ws.send(data)
                except WebSocketDisconnect:
                    await server_ws.close()

            async def server_to_client() -> None:
                try:
                    async for message in server_ws:
                        await client_ws.send_text(str(message))
                except websockets.exceptions.ConnectionClosed:
                    pass

            await asyncio.gather(client_to_server(), server_to_client())
    except (OSError, websockets.exceptions.WebSocketException) as exc:
        log.error("Chat server not reachable: %s", exc)
        await client_ws.send_text(json.dumps({
            "type": "error",
            "error": "Chat agent server is not running. Start it with: cd chat && bun run serve",
        }))
        await client_ws.close()
    finally:
        log.info("Chat WebSocket client disconnected")
