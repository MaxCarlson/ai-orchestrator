"""Proxy endpoints to the host-side LM Studio bridge."""
from __future__ import annotations

import os
from typing import Any, Dict, Optional

import httpx
from fastapi import APIRouter, HTTPException


router = APIRouter()


def _bridge_url() -> str:
    # Docker sets KO_WEB_LMS_BRIDGE_URL=http://host.docker.internal:5080 via docker-compose.
    # When running on the host directly, the bridge is on localhost.
    return os.getenv("KO_WEB_LMS_BRIDGE_URL", "http://localhost:5080").rstrip("/")


async def _proxy(method: str, path: str, payload: Optional[Dict[str, Any]] = None) -> Any:
    url = f"{_bridge_url()}{path}"
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.request(method, url, json=payload)
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"LM Studio bridge unreachable: {exc}") from exc

    if resp.headers.get("content-type", "").startswith("application/json"):
        data = resp.json()
    else:
        data = {"detail": resp.text}

    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=data)
    return data


@router.get("/status")
async def status():
    return await _proxy("GET", "/status")


@router.get("/models")
async def models():
    return await _proxy("GET", "/models")


@router.get("/loaded")
async def loaded():
    return await _proxy("GET", "/loaded")


@router.post("/load")
async def load(payload: Dict[str, Any]):
    return await _proxy("POST", "/load", payload)


@router.post("/unload")
async def unload(payload: Dict[str, Any]):
    return await _proxy("POST", "/unload", payload)


@router.post("/get")
async def get_model(payload: Dict[str, Any]):
    return await _proxy("POST", "/get", payload)


@router.post("/server/start")
async def server_start():
    return await _proxy("POST", "/server/start")


@router.post("/server/stop")
async def server_stop():
    return await _proxy("POST", "/server/stop")
