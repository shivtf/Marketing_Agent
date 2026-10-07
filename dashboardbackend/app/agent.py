"""Start/Stop for the marketing agent, forwarded to the pipeline control API (pipeline-api.md).

The agent runs on the office machine, which nothing on the internet can reach. The pipeline API records the request
and the agent applies it within about 5 s (stopping can take up to 30 s), so the dashboard polls status until inSync.
The API token stays in this backend's environment so it never reaches the browser.
"""

import os
import re
from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Depends, HTTPException

from app.auth import current_user
from app.data import _pg

router = APIRouter(prefix="/agent")
User = Annotated[dict, Depends(current_user)]

DEFAULT_URL = "https://marketing-agent-pipeline-api.onrender.com"


def _client() -> httpx.AsyncClient:
    # Generous timeout: a sleeping Render instance can take close to a minute to wake up.
    return httpx.AsyncClient(timeout=60)


def _config() -> tuple[str, dict]:
    token = (os.environ.get("AGENT_API_TOKEN") or os.environ.get("PIPELINE_API_TOKEN") or "").strip()
    if not token:
        raise HTTPException(503, "AGENT_API_TOKEN is not set on the dashboard backend")
    base = (os.environ.get("AGENT_API_URL") or DEFAULT_URL).strip().rstrip("/")
    return f"{base}/api/v1/pipeline", {"Authorization": f"Bearer {token}"}


def _camel(value: Any) -> Any:
    """snake_case keys -> camelCase, like every other route here (in_sync -> inSync)."""
    if isinstance(value, dict):
        return {re.sub(r"_([a-z])", lambda m: m.group(1).upper(), k): _camel(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_camel(v) for v in value]
    return value


async def _call(method: str, path: str, body: dict | None = None) -> dict:
    url, headers = _config()
    try:
        async with _client() as client:
            res = await client.request(method, f"{url}/{path}", headers=headers, json=body)
    except httpx.HTTPError as exc:
        raise HTTPException(502, "Can't reach the pipeline API.") from exc
    if res.status_code == 401:
        raise HTTPException(502, "The pipeline API rejected the token (check AGENT_API_TOKEN).")
    if res.is_error:
        try:
            detail = res.json().get("detail")
        except ValueError:
            detail = None
        raise HTTPException(502, f"Pipeline API error {res.status_code}: {detail or res.reason_phrase}")
    return _camel(res.json())


async def _requested_by_name(requested_by: str | None) -> str | None:
    """'dashboard:priya@x.co' -> the person's name from Supabase Auth; falls back to the email (or the raw value
    for requests made outside the dashboard, e.g. from the agent's CLI)."""
    if not requested_by:
        return None
    who = requested_by.removeprefix("dashboard:")
    if "@" not in who:
        return who
    try:
        name = await (await _pg()).fetchval(
            "select raw_user_meta_data->>'name' from auth.users where lower(email) = lower($1)", who
        )
    except Exception:  # noqa: BLE001 - a missing name must never break the status card
        name = None
    return (name or "").strip() or who


async def _with_name(status: dict) -> dict:
    status["requestedByName"] = await _requested_by_name(status.get("requestedBy"))
    return status


def _requested_by(user: dict) -> dict:
    return {"requested_by": (user.get("email") or user["sub"])[:100]}


# -> { desiredState, state: 'running' | 'stopped' | 'offline', online, inSync, currentPass, nextPassAt, lastPass,
#      requestedBy, requestedByName, ... }
@router.get("")
async def agent_status(_user: User) -> dict:
    return await _with_name(await _call("GET", "status"))


@router.post("/start")
async def start(user: User) -> dict:
    return await _with_name(await _call("POST", "start", _requested_by(user)))


@router.post("/stop")
async def stop(user: User) -> dict:
    return await _with_name(await _call("POST", "stop", _requested_by(user)))
