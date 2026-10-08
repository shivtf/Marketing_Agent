"""Verifies the Supabase access token (Bearer JWT) sent by the dashboard."""

import logging
import os
from functools import lru_cache
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

log = logging.getLogger(__name__)
bearer = HTTPBearer(auto_error=False)
ASYMMETRIC_ALGS = ["ES256", "RS256", "EdDSA"]


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status.HTTP_401_UNAUTHORIZED, detail, headers={"WWW-Authenticate": "Bearer"}
    )


def supabase_url() -> str:
    url = (
        os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or ""
    ).strip()
    if not url.startswith(("http://", "https://")):
        raise RuntimeError(
            "SUPABASE_URL is not set or is not an http(s) URL. Put it in "
            "eval/dashboardbackend/.env (see .env.example) and restart the server."
        )
    return url.rstrip("/")


@lru_cache(maxsize=1)
def _jwks_client() -> jwt.PyJWKClient:
    return jwt.PyJWKClient(f"{supabase_url()}/auth/v1/.well-known/jwks.json", cache_keys=True)


def decode_token(token: str) -> dict:
    """Return the verified claims, or raise jwt.PyJWTError."""
    options = {"require": ["exp", "sub"]}
    secret = os.environ.get("SUPABASE_JWT_SECRET")
    alg = jwt.get_unverified_header(token).get("alg")
    if alg == "HS256":
        if not secret:
            raise jwt.InvalidAlgorithmError("HS256 token but SUPABASE_JWT_SECRET is not set")
        return jwt.decode(
            token, secret, algorithms=["HS256"], audience="authenticated", options=options
        )
    key = _jwks_client().get_signing_key_from_jwt(token).key
    return jwt.decode(
        token, key, algorithms=ASYMMETRIC_ALGS, audience="authenticated", options=options
    )


# One sign-in per account: dashboard_presence (migrations/001_dashboard_presence.sql) holds, per user, the session
# that is using the account and when it was last seen. Every request from that session refreshes it; another session
# may take over only once the holder signed out, its Supabase session ended, or it has been quiet for HOLD_FOR
# (a closed tab must not lock the account forever). The open dashboard checks in every minute to keep its hold.
HOLD_FOR = "3 minutes"
_CLAIM = f"""
insert into dashboard_presence as p (user_id, session_id, last_seen) values ($1::uuid, $2::uuid, now())
on conflict (user_id) do update set session_id = excluded.session_id, last_seen = now()
  where p.session_id = excluded.session_id
     or p.last_seen < now() - interval '{HOLD_FOR}'
     or not exists (select 1 from auth.sessions s where s.id = p.session_id)
returning session_id
"""
IN_USE = "This account is already signed in on another device."
# Same as migrations/001_dashboard_presence.sql, so the check works without running that file by hand.
_CREATE = """
create table if not exists public.dashboard_presence (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  session_id uuid not null,
  last_seen  timestamptz not null default now()
);
alter table public.dashboard_presence enable row level security;
"""
_table_ready = False


async def _ensure_table(pool) -> None:
    global _table_ready
    if not _table_ready:
        await pool.execute(_CREATE)
        _table_ready = True


async def _session_ended(session_id: str) -> bool:
    """True when the token's Supabase sign-in session no longer exists (signed out, or ended by an admin)."""
    from app.data import _pg  # here, not at the top: app.data imports this module

    return await (await _pg()).fetchval("select 1 from auth.sessions where id = $1::uuid", session_id) is None


async def _claim(user_id: str, session_id: str) -> bool:
    """Take or keep the account for this session; False while another session is using it."""
    from app.data import _pg

    pool = await _pg()
    await _ensure_table(pool)
    return await pool.fetchval(_CLAIM, user_id, session_id) is not None


async def release(user_id: str, session_id: str) -> None:
    """Sign-out: free the account at once instead of after HOLD_FOR."""
    from app.data import _pg

    await (await _pg()).execute(
        "delete from dashboard_presence where user_id = $1::uuid and session_id = $2::uuid", user_id, session_id
    )


async def _check_session(claims: dict) -> None:
    session_id = claims.get("session_id")
    if not session_id:
        return
    try:
        ended = await _session_ended(session_id)
        holds = ended or await _claim(claims["sub"], session_id)
    except Exception:  # noqa: BLE001 - an extra check on top of the verified token (e.g. table not created yet)
        # Logged as an error: while this fails, a second sign-in is not refused.
        log.error("One-sign-in check failed; allowing the token", exc_info=True)
        return
    if ended:
        raise _unauthorized("Session ended")
    if not holds:
        raise HTTPException(status.HTTP_409_CONFLICT, IN_USE)


async def current_user(creds: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]) -> dict:
    """FastAPI dependency: 401 unless the request carries a valid Supabase access token from a current sign-in;
    409 while another session is using the account."""
    if creds is None:
        raise _unauthorized("Missing bearer token")
    try:
        claims = decode_token(creds.credentials)
    except jwt.PyJWTError as exc:
        raise _unauthorized("Invalid or expired token") from exc
    # Removed accounts are banned (no refresh), but an already-issued token lives until it expires; refuse it now.
    if (claims.get("app_metadata") or {}).get("removed"):
        raise _unauthorized("Account removed")
    await _check_session(claims)
    return claims
