"""Ending sign-in sessions. Supabase keeps a user's sessions alive when their password changes, so after a reset (or a
removal) these routes end them. They live here, not in the dashboard's Next.js routes, because the Supabase client
there can't end another user's sessions; this backend can, over its database connection.

Deleting a row from auth.sessions also deletes its refresh tokens (Supabase's foreign key cascades), so the session
can't be renewed. Its current access token stops working at once on this backend (current_user checks the session
still exists) and on Supabase, which refuses tokens of ended sessions.
"""

import logging
import uuid
from typing import Annotated

import asyncpg
from fastapi import APIRouter, Depends, HTTPException

from app.auth import current_admin, current_user
from app.data import _pg

log = logging.getLogger(__name__)
router = APIRouter()
User = Annotated[dict, Depends(current_user)]
Admin = Annotated[dict, Depends(current_admin)]


def _count(status: str) -> int:
    """asyncpg's 'DELETE 3' -> 3."""
    try:
        return int(status.split()[-1])
    except (ValueError, IndexError):
        return 0


async def _end(sql: str, *args) -> int:
    try:
        return _count(await (await _pg()).execute(sql, *args))
    except asyncpg.PostgresError as exc:
        log.error("Could not end sessions", exc_info=True)
        raise HTTPException(503, "Couldn't sign the account out: the database refused to end its sessions.") from exc


@router.post("/admin/users/{user_id}/end-sessions")
async def end_user_sessions(user_id: str, admin: Admin) -> dict:
    """Signs a user out everywhere (after an admin resets their password or removes them). Not for yourself: that
    would end this session too (use /auth/end-other-sessions)."""
    try:
        uid = str(uuid.UUID(user_id))
    except ValueError as exc:
        raise HTTPException(404, "User not found.") from exc
    if uid == admin["sub"]:
        raise HTTPException(400, "You can't sign yourself out here.")
    ended = await _end("delete from auth.sessions where user_id = $1::uuid", uid)
    # The account is free for a new sign-in at once (the one-sign-in rule would allow it anyway: no session is left).
    await _end("delete from public.dashboard_presence where user_id = $1::uuid", uid)
    return {"ended": ended}


@router.post("/auth/end-other-sessions")
async def end_other_sessions(user: User) -> dict:
    """After you change your own password: signs you out on every other device, keeping this session."""
    session_id = user.get("session_id")
    if not session_id:
        raise HTTPException(400, "This sign-in has no session id.")
    ended = await _end(
        "delete from auth.sessions where user_id = $1::uuid and id <> $2::uuid", user["sub"], session_id
    )
    return {"ended": ended}
