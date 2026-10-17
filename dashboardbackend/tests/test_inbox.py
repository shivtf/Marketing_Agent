"""Reading replies from Gmail (app/gmail.py, app/reply_rules.py, app/inbox.py) without Google or a database.

Google is faked with httpx.MockTransport; the real-SQL side of the inbox check is in test_inbox_sql.py.
"""

import asyncio
import base64
import secrets
import time

import httpx
import jwt
import pytest
from fastapi.testclient import TestClient

from app import data, gmail, reply_rules
from app.main import app

SECRET = secrets.token_hex(32)  # signs fake test tokens only, never a real key
client = TestClient(app)

# Made by the dashboard's own encrypt() (dashboard/core/server/gmailTokens.js) with the secret below, so this proves
# the backend reads exactly what the dashboard saved.
JS_SEALED = "v1.w3raedxOR6B7GWiN.WFcNWIejCaNdUz-cYcmsLg.1xRAUJR4iK6iLFXIh0FF_Tv-VUb-3ilL"
JS_SECRET = "js-test-client-secret"


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "client-id")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", JS_SECRET)
    gmail.forget_token()


@pytest.fixture
def tables(monkeypatch):
    """Whether migration 007 "exists" (no database is ever touched here)."""
    state = {"ready": True}

    async def ready():
        return state["ready"]

    monkeypatch.setattr(data, "inbox_ready", ready)
    return state


def _auth():
    claims = {"sub": "u1", "aud": "authenticated", "exp": int(time.time()) + 60, "app_metadata": {"role": "employee"}}
    return {"Authorization": f"Bearer {jwt.encode(claims, SECRET, algorithm='HS256')}"}


def _run(coro):
    return asyncio.run(coro)


# ---------- Rules ----------


def test_bounce_senders():
    assert reply_rules.is_bounce("mailer-daemon@googlemail.com", "Delivery Status Notification (Failure)")
    assert reply_rules.is_bounce("postmaster@acme.co", "Undeliverable: Hello")
    assert not reply_rules.is_bounce("mailer-daemon@googlemail.com", "Delivery Status Notification (Delay)")
    assert not reply_rules.is_bounce("priya@acme.co", "Mail delivery failed")


@pytest.mark.parametrize("headers,subject", [
    ({"auto-submitted": "auto-replied"}, "Re: Hello"),
    ({"x-autoreply": "yes"}, "Re: Hello"),
    ({"precedence": "auto_reply"}, "Re: Hello"),
    ({}, "Out of Office: back on Monday"),
    ({}, "Automatic reply: Hello"),
    ({}, "Abwesenheit"),
])
def test_automatic_replies(headers, subject):
    assert reply_rules.is_auto_reply(headers, subject)


def test_a_person_is_not_an_automatic_reply():
    assert not reply_rules.is_auto_reply({"auto-submitted": "no"}, "Re: Hello")
    assert not reply_rules.is_auto_reply({}, "Re: Your offer")


@pytest.mark.parametrize("text", [
    "Please unsubscribe me.", "Remove me from your list", "stop emailing me", "Don't contact us again",
    "Take me off this list please", "I want to opt-out",
])
def test_unsubscribe_wording(text):
    assert reply_rules.mentions_unsubscribe(text)


@pytest.mark.parametrize("text", ["Not interested, thanks.", "We stopped using Android", "", None,
                                  "Can you remove the second item from the quote?"])
def test_not_unsubscribe(text):
    assert not reply_rules.mentions_unsubscribe(text)


def test_message_ids_in_headers():
    assert reply_rules.message_ids("<a@x.co>", "<b@x.co> <a@x.co>", None) == ["<a@x.co>", "<b@x.co>"]


# ---------- The saved Gmail access ----------


def test_decrypts_what_the_dashboard_saved():
    assert gmail.decrypt(JS_SEALED, JS_SECRET) == "1//refresh-token-from-js"


def test_decrypt_refuses_a_wrong_secret_or_format():
    with pytest.raises(ValueError):
        gmail.decrypt(JS_SEALED, "another-secret")
    with pytest.raises(ValueError):
        gmail.decrypt("v2.a.b.c", JS_SECRET)


def _google(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_access_token_is_renewed_and_kept():
    calls = []

    def handler(req):
        calls.append(req)
        return httpx.Response(200, json={"access_token": "at-1", "expires_in": 3600})

    async def twice():
        async with _google(handler) as http:
            return [await gmail.access_token(http, JS_SEALED), await gmail.access_token(http, JS_SEALED)]

    assert _run(twice()) == ["at-1", "at-1"] and len(calls) == 1  # the second one comes from memory
    assert b"refresh_token=1%2F%2Frefresh-token-from-js" in calls[0].content


@pytest.mark.parametrize("response,status", [
    (httpx.Response(400, json={"error": "invalid_grant"}), 503),  # access ended: connect again
    (httpx.Response(500, json={}), 502),
])
def test_access_token_failures(response, status):
    async def go():
        async with _google(lambda _req: response) as http:
            await gmail.access_token(http, JS_SEALED)

    with pytest.raises(gmail.GmailError) as err:
        _run(go())
    assert err.value.status == status


def test_access_token_needs_the_google_settings(monkeypatch):
    monkeypatch.delenv("GOOGLE_CLIENT_SECRET")

    async def go():
        async with _google(lambda _req: httpx.Response(200)) as http:
            await gmail.access_token(http, JS_SEALED)

    with pytest.raises(gmail.GmailError) as err:
        _run(go())
    assert err.value.status == 503 and "GOOGLE_CLIENT_SECRET" in str(err.value)


@pytest.mark.parametrize("status,body,expected", [
    (401, {}, 503),  # never 401: the dashboard would sign the user out
    (403, {"error": {"message": "Gmail API has not been used in project 1"}}, 503),
    (429, {}, 503),
    (500, {}, 502),
])
def test_gmail_errors_never_sign_the_user_out(status, body, expected):
    async def go():
        async with _google(lambda _req: httpx.Response(status, json=body)) as http:
            await gmail.get(http, "at", "/messages")

    with pytest.raises(gmail.GmailError) as err:
        _run(go())
    assert err.value.status == expected and err.value.status not in (401, 409)


def test_a_deleted_message_is_none():
    async def go():
        async with _google(lambda _req: httpx.Response(404, json={})) as http:
            return await gmail.get(http, "at", "/messages/x")

    assert _run(go()) is None


# ---------- Messages -> text ----------


def _b64(text):
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")


def _msg(payload, headers=(("From", "Priya Shah <Priya@Acme.co>"), ("Subject", "Re: Hello"))):
    return {"id": "m1", "threadId": "t1", "labelIds": ["INBOX"], "internalDate": "1760000000000",
            "payload": {**payload, "headers": [{"name": k, "value": v} for k, v in headers]}}


def test_parse_plain_text_and_headers():
    m = gmail.parse(_msg({"mimeType": "text/plain", "body": {"data": _b64("Yes, let's talk.\r\n")}},
                         headers=(("From", "Priya Shah <Priya@Acme.co>"), ("Subject", "Re: Hello"),
                                  ("Message-ID", "<r1@acme.co>"), ("In-Reply-To", "<s1@us.co>"),
                                  ("References", "<s0@us.co> <s1@us.co>"), ("Auto-Submitted", "no"))))
    assert m["from_email"] == "priya@acme.co" and m["subject"] == "Re: Hello" and m["text"] == "Yes, let's talk."
    assert m["message_id"] == "<r1@acme.co>" and m["in_reply_to"] == "<s1@us.co>"
    assert m["headers"]["auto-submitted"] == "no" and m["thread_id"] == "t1"
    assert m["received_at"].isoformat() == "2025-10-09T08:53:20+00:00"


def test_parse_html_only_mail():
    html = "<html><head><style>p{}</style></head><body><p>Hi&nbsp;Alex</p><p>Call me &amp; send times</p></body>"
    m = gmail.parse(_msg({"mimeType": "text/html", "body": {"data": _b64(html)}}))
    assert m["text"] == "Hi Alex\n\nCall me & send times"


def test_parse_multipart_prefers_text_and_skips_attachments():
    payload = {"mimeType": "multipart/mixed", "parts": [
        {"mimeType": "text/plain", "filename": "notes.txt", "body": {"attachmentId": "a1", "data": _b64("secret")}},
        {"mimeType": "multipart/alternative", "parts": [
            {"mimeType": "text/html", "body": {"data": _b64("<p>HTML version</p>")}},
            {"mimeType": "text/plain", "body": {"data": _b64("Text version")}},
        ]},
    ]}
    assert gmail.parse(_msg(payload))["text"] == "Text version"


def test_parse_cuts_very_long_mail():
    m = gmail.parse(_msg({"mimeType": "text/plain", "body": {"data": _b64("x" * 30_000)}}))
    assert len(m["text"]) == gmail.MAX_BODY


# ---------- Routes: login, input, migration not run ----------


def test_inbox_routes_need_login():
    assert client.post("/inbox/check").status_code == 401
    assert client.post("/inbox/label", json={}).status_code == 401


def test_inbox_routes_before_the_migration(tables):
    tables["ready"] = False
    for res in (client.post("/inbox/check", headers=_auth()),
                client.post("/inbox/label", headers=_auth(), json={
                    "source": "inbox", "replyId": "0b6b0f90-3f0e-4b8a-9c6d-2e1f0a9b8c7d", "label": "interested"})):
        assert res.status_code == 503 and "007_inbox_replies.sql" in res.json()["detail"]


@pytest.mark.parametrize("body", [
    {"source": "inbox", "replyId": "0b6b0f90-3f0e-4b8a-9c6d-2e1f0a9b8c7d", "label": "maybe"},
    {"source": "other", "replyId": "0b6b0f90-3f0e-4b8a-9c6d-2e1f0a9b8c7d", "label": "interested"},
    {"source": "inbox", "replyId": "not-a-uuid", "label": "interested"},
    {"source": "inbox", "replyId": "0b6b0f90-3f0e-4b8a-9c6d-2e1f0a9b8c7d"},  # label missing (null is allowed)
])
def test_label_checks_its_input(tables, body):
    assert client.post("/inbox/label", headers=_auth(), json=body).status_code == 422
