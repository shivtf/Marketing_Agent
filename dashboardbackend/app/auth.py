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


async def _session_ended(session_id: str | None) -> bool:
    """True when the token's sign-in session no longer exists in Supabase Auth. The dashboard ends an account's
    other sessions when it signs in, so a token from an older sign-in stops working at once instead of at expiry.
    If the check can't run (no database, no access to auth.sessions), the token is allowed."""
    if not session_id:
        return False
    from app.data import _pg  # here, not at the top: app.data imports this module

    try:
        alive = await (await _pg()).fetchval("select 1 from auth.sessions where id = $1::uuid", session_id)
    except Exception:  # noqa: BLE001 - this is an extra check on top of the verified token
        log.warning("Could not check the sign-in session; allowing the token", exc_info=True)
        return False
    return alive is None


async def current_user(creds: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]) -> dict:
    """FastAPI dependency: 401 unless the request carries a valid Supabase access token from a current sign-in."""
    if creds is None:
        raise _unauthorized("Missing bearer token")
    try:
        claims = decode_token(creds.credentials)
    except jwt.PyJWTError as exc:
        raise _unauthorized("Invalid or expired token") from exc
    # Removed accounts are banned (no refresh), but an already-issued token lives until it expires; refuse it now.
    if (claims.get("app_metadata") or {}).get("removed"):
        raise _unauthorized("Account removed")
    if await _session_ended(claims.get("session_id")):
        raise _unauthorized("Signed in on another device")
    return claims
