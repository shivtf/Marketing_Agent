"""Reading replies from Gmail (app/gmail.py, app/reply_rules.py, app/inbox.py) without Google or a database.

Google is faked with httpx.MockTransport; the real-SQL side of the inbox check is in test_inbox_sql.py.
"""

import asyncio
import base64
import secrets
import time

import asyncpg
import httpx
import jwt
import pytest
from fastapi.testclient import TestClient

from app import data, gmail, inbox, reply_rules
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
    # Exchange's own sender, and any delivery report (RFC 3464), whoever sends it.
    assert reply_rules.is_bounce("microsoftexchange329e71ec88ae4615bbc36ab6ce41109e@acme.co", "Undeliverable: Hello")
    report = {"content-type": 'multipart/report; report-type=delivery-status; boundary="x"'}
    assert reply_rules.is_bounce("noreply@mail.acme.co", "Returned mail", report)
    assert not reply_rules.is_bounce("noreply@mail.acme.co", "Delayed: Hello", report)


@pytest.mark.parametrize("headers,subject", [
    ({"auto-submitted": "auto-replied"}, "Re: Hello"),
    ({"x-autoreply": "yes"}, "Re: Hello"),
    ({"precedence": "auto_reply"}, "Re: Hello"),
    ({}, "Out of Office: back on Monday"),
    ({}, "Automatic reply: Hello"),
    ({}, "Abwesenheit"),
    ({}, "Absence: back on Monday"),
    ({}, "Abwesenheitsnotiz: Hello"),
    ({}, "Re: Hello [Out of Office]"),
])
def test_automatic_replies(headers, subject):
    assert reply_rules.is_auto_reply(headers, subject)


def test_a_person_is_not_an_automatic_reply():
    assert not reply_rules.is_auto_reply({"auto-submitted": "no"}, "Re: Hello")
    assert not reply_rules.is_auto_reply({}, "Re: Your offer")
    # Words a person may use in a subject too.
    assert not reply_rules.is_auto_reply({}, "Re: absence of a plan")
    assert not reply_rules.is_auto_reply({}, "Re: our team on leave policies")
    assert not reply_rules.is_auto_reply({}, "Re: vacation rentals on vacation sites")


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


def test_inbox_routes_before_the_migration(monkeypatch):
    class NoTables:  # a database where neither migration 006 nor 007 has been run
        async def _missing(self, *_):
            raise asyncpg.UndefinedTableError("relation does not exist")

        fetch = fetchrow = fetchval = execute = _missing

        def acquire(self):  # also a connection, with a transaction
            return self

        transaction = acquire

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

    async def pg():
        return NoTables()

    monkeypatch.setattr(data, "_pg", pg)
    label = client.post("/inbox/label", headers=_auth(), json={
        "replyId": "0b6b0f90-3f0e-4b8a-9c6d-2e1f0a9b8c7d", "label": "interested"})
    assert label.status_code == 503 and "007_inbox_replies.sql" in label.json()["detail"]
    assert client.post("/inbox/check", headers=_auth()).status_code == 503  # no gmail_connection: not connected


@pytest.mark.parametrize("body", [
    {"replyId": "0b6b0f90-3f0e-4b8a-9c6d-2e1f0a9b8c7d", "label": "maybe"},
    {"replyId": "not-a-uuid", "label": "interested"},
    {"replyId": "0b6b0f90-3f0e-4b8a-9c6d-2e1f0a9b8c7d"},  # label missing (null is allowed)
])
def test_label_checks_its_input(body):
    assert client.post("/inbox/label", headers=_auth(), json=body).status_code == 422


# ---------- One check reads batches until it has caught up ----------


def _fake_check(monkeypatch, n):
    from datetime import UTC, datetime

    class Pool:
        async def fetchval(self, sql, *_):
            return datetime(2026, 10, 1, tzinfo=UTC) if "min(sent_at)" in sql else 0

        async def fetch(self, sql, *_):
            return []  # nothing seen yet

    async def pg():
        return Pool()

    async def connection(_pool):
        return {"email": "us@us.test", "refresh_token": "sealed"}

    async def token(*_):
        return "at"

    async def list_ids(_http, _token, query):
        return [f"m{i}" for i in range(n)]

    async def fetch_all(_http, _token, ids):
        return [{} for _ in ids]

    async def process(*_):
        return "not_reply", False

    async def nothing(*_):
        return 0, 0

    async def no_threads(*_):
        return 0

    monkeypatch.setattr(inbox.data, "_pg", pg)
    monkeypatch.setattr(inbox, "_connection", connection)
    monkeypatch.setattr(inbox.gmail, "access_token", token)
    monkeypatch.setattr(inbox, "_list_ids", list_ids)
    monkeypatch.setattr(inbox, "_fetch_all", fetch_all)
    monkeypatch.setattr(inbox, "_process", process)
    monkeypatch.setattr(inbox, "_recheck", nothing)
    monkeypatch.setattr(inbox, "_refresh_follow_ups", no_threads)
    return asyncio.run(inbox._check())


def test_a_check_reads_batches_until_it_has_caught_up(monkeypatch):
    res = _fake_check(monkeypatch, 260)
    assert (res["processed"], res["remaining"]) == (inbox.MAX_PER_CHECK, 260 - inbox.MAX_PER_CHECK)
    res = _fake_check(monkeypatch, 30)
    assert (res["processed"], res["remaining"]) == (30, 0)


def test_a_check_stops_when_its_time_is_up(monkeypatch):
    monkeypatch.setattr(inbox, "CHECK_SECONDS", 0)
    res = _fake_check(monkeypatch, 30)
    assert (res["processed"], res["remaining"]) == (0, 30)


@pytest.mark.parametrize(("value", "minutes"), [(None, None), ("", None), ("0", None), ("abc", None), ("0.2", 1.0),
                                                ("5", 5.0)])
def test_scheduled_check_interval(monkeypatch, value, minutes):
    if value is None:
        monkeypatch.delenv("INBOX_CHECK_EVERY_MINUTES", raising=False)
    else:
        monkeypatch.setenv("INBOX_CHECK_EVERY_MINUTES", value)
    assert inbox.check_interval() == minutes
