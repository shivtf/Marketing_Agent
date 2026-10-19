"""Verifies the Supabase access token (Bearer JWT) sent by the dashboard."""

import logging
import os
import time
from functools import lru_cache
from typing import Annotated

import asyncpg
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

log = logging.getLogger(__name__)
bearer = HTTPBearer(auto_error=False)
ASYMMETRIC_ALGS = ["ES256", "RS256", "EdDSA"]
# Dashboard roles, set by an admin in app_metadata (only the service key can write it). A Supabase account without
# one (e.g. one that signed itself up) gets no access, whatever the project's sign-up setting is.
ROLES = ("admin", "employee")
NO_ACCESS = "This account has no access to the dashboard."


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
            "dashboardbackend/.env and restart the server."
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
# HOLD_FOR is a constant; the values are $1/$2.
_CLAIM = f"""
insert into dashboard_presence as p (user_id, session_id, last_seen) values ($1::uuid, $2::uuid, now())
on conflict (user_id) do update set session_id = excluded.session_id, last_seen = now()
  where p.session_id = excluded.session_id
     or p.last_seen < now() - interval '{HOLD_FOR}'
     or not exists (select 1 from auth.sessions s where s.id = p.session_id)
returning session_id
"""  # noqa: S608
IN_USE = "This account is already signed in on another device."
# The check can't run (database unreachable, table missing): the request is refused with 503, never let through, so a
# removed account or a second sign-in can't slip in during an outage. 503, not 401/409: the dashboard keeps the user
# signed in and offers Retry.
CHECK_FAILED = "Couldn't check your sign-in right now. Try again in a moment."
NO_PRESENCE_TABLE = ("The sign-in check needs the dashboard_presence table. Run "
                     "dashboardbackend/migrations/001_dashboard_presence.sql in the Supabase SQL editor.")

# A session that passed the check is not checked again for CHECKED_FOR seconds: the dashboard sends several requests
# per page, and each check is 2-3 database round trips. The cost: a removal or a sign-out on another device takes up to
# that long to reach this server (sign-out here, and an admin's "end sessions", clear it at once). Short enough that
# the hold on the account (HOLD_FOR) is still refreshed long before it runs out.
CHECKED_FOR = 30.0
_checked: dict[tuple[str, str], float] = {}  # (user id, session id) -> time.monotonic() of the last check that passed


def forget_checks(user_id: str, session_id: str | None = None) -> None:
    """Check this user's sessions (or one session) again on their next request."""
    for key in [k for k in _checked if k[0] == user_id and session_id in (None, k[1])]:
        _checked.pop(key, None)


async def call_or_sql(pool, method: str, fn_sql: str, raw_sql: str, *args):
    """The narrow function from migrations/009 (the limited login), or, while that file is not applied yet, the same query
    straight on the tables (which only the owner login may run)."""
    try:
        return await getattr(pool, method)(fn_sql, *args)
    except asyncpg.UndefinedFunctionError:
        return await getattr(pool, method)(raw_sql, *args)


# Read from the database, not the token: a token issued before an admin removed the account still says "not
# removed" until it expires (up to an hour), and the account's sessions may still exist.
_ACCOUNT = """
select exists (select 1 from auth.sessions s where s.id = $2::uuid and s.user_id = u.id) as session_alive,
       coalesce((u.raw_app_meta_data->>'removed')::boolean, false)
         or coalesce(u.banned_until > now(), false) as removed
from auth.users u
where u.id = $1::uuid
"""


async def _account(user_id: str, session_id: str) -> tuple[bool, bool]:
    """(session ended, account removed or banned) for the token's user and sign-in session."""
    from app.data import _pg  # here, not at the top: app.data imports this module

    row = await call_or_sql(
        await _pg(),
        "fetchrow",
        "select session_alive, removed from public.dashboard_account_state($1::uuid, $2::uuid)",
        _ACCOUNT,
        user_id,
        session_id,
    )
    if row is None:  # the user no longer exists
        return True, True
    return not row["session_alive"], row["removed"]


async def _claim(user_id: str, session_id: str) -> bool:
    """Take or keep the account for this session; False while another session is using it."""
    from app.data import _pg

    pool = await _pg()
    fn = f"select public.dashboard_claim($1::uuid, $2::uuid, interval '{HOLD_FOR}')"
    return await call_or_sql(pool, "fetchval", fn, _CLAIM, user_id, session_id) is not None


async def release(user_id: str, session_id: str) -> None:
    """Sign-out: free the account at once instead of after HOLD_FOR."""
    from app.data import _pg

    forget_checks(user_id, session_id)
    await (await _pg()).execute(
        "delete from dashboard_presence where user_id = $1::uuid and session_id = $2::uuid", user_id, session_id
    )


async def _check_session(claims: dict) -> None:
    session_id = claims.get("session_id")
    if not session_id:
        return
    key = (claims["sub"], session_id)
    now = time.monotonic()
    if now - _checked.get(key, float("-inf")) < CHECKED_FOR:
        return
    try:
        ended, removed = await _account(claims["sub"], session_id)
        holds = ended or removed or await _claim(claims["sub"], session_id)
    except asyncpg.UndefinedTableError as exc:
        log.error("Sign-in check failed: dashboard_presence is missing", exc_info=True)
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, NO_PRESENCE_TABLE) from exc
    except HTTPException:
        raise  # e.g. DATABASE_URL not set: already a clear answer
    except Exception as exc:  # noqa: BLE001 - any other failure: refuse, don't guess
        log.error("Sign-in check failed; refusing the request", exc_info=True)
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, CHECK_FAILED) from exc
    if removed:
        raise _unauthorized("Account removed")
    if ended:
        raise _unauthorized("Session ended")
    if not holds:
        raise HTTPException(status.HTTP_409_CONFLICT, IN_USE)
    if len(_checked) > 10_000:  # never grows without bound: old entries are useless after CHECKED_FOR anyway
        for k in [k for k, t in _checked.items() if now - t >= CHECKED_FOR]:
            del _checked[k]
    _checked[key] = now


async def current_user(creds: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]) -> dict:
    """FastAPI dependency: 401 unless the request carries a valid Supabase access token from a current sign-in;
    403 for an account without a dashboard role; 409 while another session is using the account; 503 when the
    sign-in check itself can't run (never let through unchecked)."""
    if creds is None:
        raise _unauthorized("Missing bearer token")
    try:
        claims = decode_token(creds.credentials)
    except jwt.PyJWTError as exc:
        raise _unauthorized("Invalid or expired token") from exc
    app_metadata = claims.get("app_metadata") or {}
    # Fast path for tokens issued after removal; _check_session also catches older ones from the database.
    if app_metadata.get("removed"):
        raise _unauthorized("Account removed")
    # Checked before the sign-in check, so an account without a role never takes the account's sign-in.
    if app_metadata.get("role") not in ROLES:
        raise HTTPException(status.HTTP_403_FORBIDDEN, NO_ACCESS)
    await _check_session(claims)
    return claims


async def current_admin(user: Annotated[dict, Depends(current_user)]) -> dict:
    """FastAPI dependency: 403 unless the user is an admin. The role is read from the database, not the token:
    a token can be up to an hour out of date after an admin changes someone's role."""
    from app.data import _pg

    try:
        role = await call_or_sql(
            await _pg(),
            "fetchval",
            "select public.dashboard_user_role($1::uuid)",
            "select raw_app_meta_data->>'role' from auth.users where id = $1::uuid",
            user["sub"],
        )
    except Exception as exc:  # noqa: BLE001 - unlike the checks above, admin actions fail closed
        log.error("Could not read the user's role", exc_info=True)
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Couldn't check your role. Try again.") from exc
    if role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admins only.")
    return user
