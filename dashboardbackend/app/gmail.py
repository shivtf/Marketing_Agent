"""Read-only Gmail access for the backend: the one inbox an admin connected on the History page.

The dashboard's Next.js server saved that connection (dashboard/core/server/gmail.js) in public.gmail_connection, with
the refresh token encrypted by dashboard/core/server/gmailTokens.js. This module reads the same row and decrypts it
the same way (AES-256-GCM, key from GOOGLE_CLIENT_SECRET), so the backend needs GOOGLE_CLIENT_ID and
GOOGLE_CLIENT_SECRET too. Only GET calls are made: nothing here sends, labels, marks as read or deletes mail.

Every failure is a GmailError with a status for the dashboard: 503 when someone has to act (set up, connect, connect
again), 502 when Google did not answer. Never 401 or 409: the dashboard signs the user out on those.
"""

import base64
import email.utils
import html
import os
import re
import time
from datetime import UTC, datetime

import httpx
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

API = "https://gmail.googleapis.com/gmail/v1/users/me"
TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105 - a URL, not a secret
TIMEOUT = 20.0
MAX_BODY = 20_000  # same cut-off as the mail agent's stored replies

NOT_CONNECTED = "Gmail is not connected. An admin can connect it on the History page."
RECONNECT = ("Google ended the dashboard's Gmail access (the Google app is still in Testing and 7 days passed, the "
             "password changed, or the access was removed). An admin can connect Gmail again on the History page.")


class GmailError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def client() -> httpx.AsyncClient:
    """The HTTP client for one inbox check (tests swap this for one with a fake transport)."""
    return httpx.AsyncClient(timeout=TIMEOUT)


def _config() -> tuple[str, str]:
    cid = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
    secret = os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()
    if not (cid and secret):
        raise GmailError(503, "Gmail is not set up on the backend: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are "
                              "missing on the server.")
    return cid, secret


def _b64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def decrypt(sealed: str, secret: str) -> str:
    """'v1.<iv>.<tag>.<data>' (gmailTokens.js encrypt()) -> the refresh token. Raises ValueError if it can't."""
    parts = str(sealed).split(".")
    if len(parts) != 4 or parts[0] != "v1":
        raise ValueError("Unknown token format.")
    _, iv, tag, data = parts
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=b"marketing-dashboard-gmail", info=b"token").derive(
        secret.encode()
    )
    try:
        return AESGCM(key).decrypt(_b64(iv), _b64(data) + _b64(tag), None).decode()
    except Exception as exc:  # noqa: BLE001 - wrong secret or a changed value: the same answer either way
        raise ValueError("The token can't be decrypted.") from exc


# The access token Google last gave out, kept until a minute before it expires (they last an hour). `sealed` ties it
# to the saved connection, so a reconnect is noticed.
_cache: dict = {"token": None, "until": 0.0, "sealed": None}


def forget_token() -> None:
    _cache.update(token=None, until=0.0, sealed=None)


async def access_token(http: httpx.AsyncClient, sealed: str) -> str:
    cid, secret = _config()
    if _cache["token"] and _cache["sealed"] == sealed and time.monotonic() < _cache["until"]:
        return _cache["token"]
    try:
        refresh = decrypt(sealed, secret)
    except ValueError as exc:
        raise GmailError(503, "The saved Gmail access can no longer be read (the Google client secret changed). An "
                              "admin can connect Gmail again on the History page.") from exc
    try:
        res = await http.post(TOKEN_URL, data={"client_id": cid, "client_secret": secret, "refresh_token": refresh,
                                              "grant_type": "refresh_token"})
    except httpx.HTTPError as exc:
        raise GmailError(502, "Google did not answer. Try again in a minute.") from exc
    data = _json(res)
    if data.get("error") == "invalid_grant":
        raise GmailError(503, RECONNECT)
    if res.status_code != 200 or not data.get("access_token"):
        raise GmailError(502, f"Google refused to renew the Gmail access ({data.get('error') or res.status_code}). "
                              "Try again in a minute.")
    _cache.update(token=data["access_token"], sealed=sealed,
                  until=time.monotonic() + float(data.get("expires_in") or 0) - 60)
    return data["access_token"]


def _json(res: httpx.Response) -> dict:
    try:
        body = res.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


async def get(http: httpx.AsyncClient, token: str, path: str, params: dict | list | None = None) -> dict | None:
    """GET a Gmail API path under users/me. None when the item no longer exists (404)."""
    try:
        res = await http.get(f"{API}{path}", params=params, headers={"Authorization": f"Bearer {token}"})
    except httpx.HTTPError as exc:
        raise GmailError(502, "Gmail did not answer. Try again in a minute.") from exc
    if res.status_code == 200:
        return _json(res)
    if res.status_code == 404:
        return None
    why = str((_json(res).get("error") or {}).get("message") or "")
    if res.status_code == 401:
        forget_token()
        raise GmailError(503, RECONNECT)
    if res.status_code == 403 and re.search(r"has not been used|is disabled", why, re.IGNORECASE):
        raise GmailError(503, "The Gmail API is not enabled in the Google Cloud project (APIs & Services → Library → "
                              "Gmail API → Enable).")
    if res.status_code == 429 or "rate limit" in why.lower():
        raise GmailError(503, "Gmail is limiting requests. Wait a minute and try again.")
    raise GmailError(502, f"Gmail answered {res.status_code}. Try again in a minute.")


# ---------- Messages -> text ----------


def html_to_text(markup: str | None) -> str:
    """Mail HTML -> plain text (same rules as the dashboard's gmailMessage.js htmlToText)."""
    s = re.sub(r"<(script|style|head|title)\b[\s\S]*?</\1\s*>", "", markup or "", flags=re.IGNORECASE)
    s = re.sub(r"<!--[\s\S]*?-->", "", s)
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.IGNORECASE)
    # Quoted mail (<blockquote>) becomes "> " lines, as in a plain-text reply, so it is known to be quoted.
    s = re.sub(r"<blockquote\b[^>]*>", "\n\x01\n", s, flags=re.IGNORECASE)
    s = re.sub(r"</blockquote\s*>", "\n\x02\n", s, flags=re.IGNORECASE)
    s = re.sub(r"</(p|div|h[1-6]|li|tr|table)\s*>", "\n\n", s, flags=re.IGNORECASE)
    s = re.sub(r"<li\b[^>]*>", "- ", s, flags=re.IGNORECASE)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s).replace("\xa0", " ")
    lines, depth = [], 0
    for line in s.split("\n"):
        if line.strip() in ("\x01", "\x02"):
            depth = depth + 1 if line.strip() == "\x01" else max(0, depth - 1)
            continue
        lines.append("> " * depth + line if depth and line.strip() else line)
    s = re.sub(r"[ \t]+\n", "\n", "\n".join(lines))
    return re.sub(r"\n{3,}", "\n\n", s).strip()


def _parts(part: dict | None, out: list[dict] | None = None) -> list[dict]:
    out = [] if out is None else out
    if part:
        out.append(part)
        for child in part.get("parts") or []:
            _parts(child, out)
    return out


def body_text(payload: dict | None) -> str:
    """The message text: its text/plain part, else its HTML as text. Attachments are never read."""
    found = [p for p in _parts(payload) if (p.get("body") or {}).get("data") and not p.get("filename")]
    plain = next((p for p in found if p.get("mimeType") == "text/plain"), None)
    markup = next((p for p in found if p.get("mimeType") == "text/html"), None)
    if plain:
        text = _b64(plain["body"]["data"]).decode("utf-8", "replace").replace("\r\n", "\n").replace("\r", "\n")
    elif markup:
        text = html_to_text(_b64(markup["body"]["data"]).decode("utf-8", "replace"))
    else:
        text = ""
    return text.strip()[:MAX_BODY]


def parse(msg: dict) -> dict:
    """A Gmail API message (format=full) -> the fields the inbox check uses."""
    headers: dict[str, str] = {}
    for h in (msg.get("payload") or {}).get("headers") or []:
        headers.setdefault(str(h.get("name", "")).lower(), str(h.get("value", "")))
    millis = int(msg.get("internalDate") or 0)
    return {
        "id": msg["id"],
        "thread_id": msg.get("threadId"),
        "labels": msg.get("labelIds") or [],
        "received_at": datetime.fromtimestamp(millis / 1000, UTC),
        "from_email": email.utils.parseaddr(headers.get("from", ""))[1].lower(),
        "subject": headers.get("subject", ""),
        "message_id": headers.get("message-id", "").strip() or None,
        "in_reply_to": headers.get("in-reply-to", ""),
        "references": headers.get("references", ""),
        "headers": headers,
        "text": body_text(msg.get("payload")),
    }
