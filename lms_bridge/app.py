#!/usr/bin/env python3
"""
LM Studio CLI bridge for web UI control.
Runs lms.exe commands on the host and exposes a small HTTP API.
"""
from __future__ import annotations

import json
import os
import subprocess
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


LMS_BINARY = os.getenv("LMS_BINARY", "lms.exe")
LMS_HOST = os.getenv("LMS_HOST")
LMS_PORT = os.getenv("LMS_PORT")


def _append_instance_args(args: List[str]) -> List[str]:
    if LMS_HOST:
        args.extend(["--host", LMS_HOST])
    if LMS_PORT:
        args.extend(["--port", str(LMS_PORT)])
    return args


def _run_lms(args: List[str], timeout: int = 300) -> Dict[str, Any]:
    cmd = [LMS_BINARY] + _append_instance_args(list(args))
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to run lms: {exc}") from exc
    return {
        "command": " ".join(cmd),
        "exit_code": result.returncode,
        "stdout": result.stdout.strip(),
        "stderr": result.stderr.strip(),
    }


def _json_or_error(raw: Dict[str, Any]) -> Any:
    if raw["exit_code"] != 0:
        raise HTTPException(status_code=400, detail=raw)
    if not raw["stdout"]:
        return []
    try:
        return json.loads(raw["stdout"])
    except json.JSONDecodeError:
        return raw["stdout"]


class LoadRequest(BaseModel):
    path: Optional[str] = None
    identifier: Optional[str] = None
    ttl: Optional[int] = None
    gpu: Optional[str] = None
    context_length: Optional[int] = None
    exact: bool = False
    yes: bool = True
    estimate_only: bool = False


class GetRequest(BaseModel):
    model_name: str = Field(..., min_length=1)
    gguf: bool = False
    mlx: bool = False
    limit: Optional[int] = None
    always_show_all: bool = False
    always_show_download: bool = False
    yes: bool = True


class UnloadRequest(BaseModel):
    identifier: Optional[str] = None
    all: bool = False


app = FastAPI(title="LM Studio Bridge", version="0.1.0")


@app.get("/health")
def health():
    return {"status": "ok", "binary": LMS_BINARY}


@app.get("/status")
def status():
    return _run_lms(["status"])


@app.get("/models")
def models():
    raw = _run_lms(["ls", "--json", "--quiet"])
    return _json_or_error(raw)


@app.get("/loaded")
def loaded():
    raw = _run_lms(["ps", "--json", "--quiet"])
    return _json_or_error(raw)


@app.post("/load")
def load_model(payload: LoadRequest):
    args = ["load"]
    if payload.path:
        args.append(payload.path)
    if payload.ttl is not None:
        args.extend(["--ttl", str(payload.ttl)])
    if payload.gpu:
        args.extend(["--gpu", payload.gpu])
    if payload.context_length is not None:
        args.extend(["--context-length", str(payload.context_length)])
    if payload.identifier:
        args.extend(["--identifier", payload.identifier])
    if payload.exact:
        args.append("--exact")
    if payload.yes:
        args.append("--yes")
    if payload.estimate_only:
        args.append("--estimate-only")
    return _run_lms(args, timeout=900)


@app.post("/unload")
def unload_model(payload: UnloadRequest):
    args = ["unload"]
    if payload.all:
        args.append("--all")
    elif payload.identifier:
        args.append(payload.identifier)
    return _run_lms(args, timeout=300)


@app.post("/get")
def get_model(payload: GetRequest):
    args = ["get", payload.model_name]
    if payload.gguf:
        args.append("--gguf")
    if payload.mlx:
        args.append("--mlx")
    if payload.limit is not None:
        args.extend(["--limit", str(payload.limit)])
    if payload.always_show_all:
        args.append("--always-show-all-results")
    if payload.always_show_download:
        args.append("--always-show-download-options")
    if payload.yes:
        args.append("--yes")
    return _run_lms(args, timeout=1800)


@app.post("/server/start")
def server_start():
    return _run_lms(["server", "start"], timeout=120)


@app.post("/server/stop")
def server_stop():
    return _run_lms(["server", "stop"], timeout=120)
