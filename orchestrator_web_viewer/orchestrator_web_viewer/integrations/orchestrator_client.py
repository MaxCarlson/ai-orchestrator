"""
HTTP client helpers for talking to the AI Orchestrator service.
"""
from __future__ import annotations

import os
from typing import Any, Dict, Optional

import httpx
from fastapi import HTTPException


def _base_url() -> str:
    """Resolve the orchestrator API base URL from environment variables."""
    return os.getenv(
        "KO_WEB_ORCH_URL",
        os.getenv("ORCHESTRATOR_API_URL", "http://localhost:8000"),
    ).rstrip("/")


async def _request(
    method: str,
    path: str,
    *,
    params: Optional[Dict[str, Any]] = None,
    json: Optional[Dict[str, Any]] = None,
    timeout: float = 60.0,
) -> Any:
    """Perform an HTTP request against the orchestrator API and handle errors."""
    url = f"{_base_url()}{path}"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.request(method, url, params=params, json=json)
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text or exc.response.reason_phrase
        raise HTTPException(status_code=exc.response.status_code, detail=detail) from exc
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"Orchestrator unreachable: {exc}") from exc

    if response.headers.get("content-type", "").startswith("application/json"):
        return response.json()
    return {"status": "ok", "detail": response.text}


async def _raw_request(
    method: str,
    path: str,
    *,
    params: Optional[Dict[str, Any]] = None,
    data: Any = None,
    files: Any = None,
    timeout: float = 300.0,
) -> Any:
    url = f"{_base_url()}{path}"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.request(method, url, params=params, data=data, files=files)
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text or exc.response.reason_phrase
        raise HTTPException(status_code=exc.response.status_code, detail=detail) from exc
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"Orchestrator unreachable: {exc}") from exc

    if response.headers.get("content-type", "").startswith("application/json"):
        return response.json()
    return {"status": "ok", "detail": response.text}


async def orchestrator_get(path: str, params: Optional[Dict[str, Any]] = None) -> Any:
    """Proxy a GET request to the orchestrator."""
    return await _request("GET", path, params=params)


async def orchestrator_post(path: str, payload: Optional[Dict[str, Any]] = None) -> Any:
    """Proxy a POST request to the orchestrator."""
    return await _request("POST", path, json=payload)


async def orchestrator_delete(path: str) -> Any:
    """Proxy a DELETE request to the orchestrator."""
    return await _request("DELETE", path)


async def orchestrator_multipart_post(path: str, *, data: Dict[str, Any], files: Any) -> Any:
    """Proxy a multipart POST request to the orchestrator."""
    return await _raw_request("POST", path, data=data, files=files)
