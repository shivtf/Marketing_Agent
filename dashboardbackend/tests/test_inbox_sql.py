"""The inbox check and Positive Leads against a REAL Postgres, with Gmail faked. Nothing here touches Supabase or Google.

The database gets a minimal copy of the mail agent's tables plus this project's own migrations 006 and 007, run from
their files. Gmail is an httpx.MockTransport serving the made-up inbox below. Every lead and message is fake.

    Lead          Our email                   In the inbox                                   Expected
    ------------  --------------------------  ---------------------------------------------  -----------------------------
    Priya         <s-priya@us.test>, thread A  "Yes, let's talk" In-Reply-To our email; we     Needs review (not labelled),
                                               answered later in thread A                     Responded, follow-up replied
    Tom           thread T                     "Sounds interesting" in thread T, no headers   Needs review, Responded
    Sam           thread S                     "Hello" from Sam's address, another thread     Needs review (sender only),
                                                                                              NOT counted as Responded
    Olga          <s-olga@us.test>             out-of-office (Auto-Submitted)                 not listed, not Responded
    Uma           <s-uma@us.test>              "Please remove me from your list"              Unsubscribe group
    Ben           <s-ben@us.test>              mailer-daemon notice quoting our Message-ID    Bounced
    Ann           (agent reply: interested)    the agent stored it already (m-ann)            Positive, never fetched
    Dana          <s-dana@us.test>             read by us, then also stored by the agent      shown once, as the agent's
    Leo           (added only after the check)  "Count me in" In-Reply-To <s-leo@us.test>       not a reply at first; found by
                                                                                              the next check once added
    -             -                            our own mail, a stranger's mail                stored nowhere
"""

import asyncio
import base64
import pathlib
import secrets
import time

import asyncpg
import httpx
import jwt
import pytest
from conftest import throwaway_postgres
from fastapi.testclient import TestClient

from app import data, gmail
from app.main import app

SECRET = secrets.token_hex(32)  # signs fake test tokens only
MIGRATIONS = pathlib.Path(__file__).parent.parent / "migrations"
# The dashboard's own encrypt() output (see test_inbox.py), so the check decrypts what the dashboard really saves.
SEALED = "v1.w3raedxOR6B7GWiN.WFcNWIejCaNdUz-cYcmsLg.1xRAUJR4iK6iLFXIh0FF_Tv-VUb-3ilL"
GOOGLE_SECRET = "js-test-client-secret"
OWN = "us@us.test"

# The agent's tables: only the columns the dashboard reads.
SCHEMA = """
create table companies (
  id uuid primary key default gen_random_uuid(), name text, domain text, source text, source_url text,
  project_summary text, industry text, lead_status text not null default 'SENT',
  created_at timestamptz not null default now());
create table contacts (
  id uuid primary key default gen_random_uuid(), company_id uuid references companies, name text, email text,
  role text, collected_at timestamptz not null default now(), last_engaged_at timestamptz);
create table emails (
  id uuid primary key default gen_random_uuid(), contact_id uuid references contacts, mailbox text, subject text,
  body text, status text, sent_at timestamptz, reply_id uuid, message_id text, gmail_message_id text, gmail_thread_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table replies (
  id uuid primary key default gen_random_uuid(), contact_id uuid references contacts, email_id uuid references emails,
  received_at timestamptz not null, label text, review_note text, body text, message_id text,
  gmail_message_id text unique, gmail_thread_id text);
"""

# name: (our email's Message-ID, its Gmail thread, status)
LEADS = {
    "Priya": ("<s-priya@us.test>", "thread-a", "sent"),
    "Tom": ("<s-tom@us.test>", "thread-t", "sent"),
    "Sam": ("<s-sam@us.test>", "thread-s", "sent"),
    "Olga": ("<s-olga@us.test>", "thread-o", "sent"),
    "Uma": ("<s-uma@us.test>", "thread-u", "sent"),
    "Ben": ("<s-ben@us.test>", "thread-b", "sent"),
    "Ann": ("<s-ann@us.test>", "thread-n", "sent"),
    "Dana": ("<s-dana@us.test>", "thread-d", "sent"),
}

DAY = 86_400_000
NOW = int(time.time() * 1000)


def _b64(text):
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")


def _mail(gid, thread, sender, text, days_ago, subject="Re: Hello", labels=("INBOX",), **headers):
    hs = [{"name": "From", "value": sender}, {"name": "Subject", "value": subject}]
    hs += [{"name": k.replace("_", "-"), "value": v} for k, v in headers.items()]
    return {"id": gid, "threadId": thread, "labelIds": list(labels), "internalDate": str(int(NOW - days_ago * DAY)),
            "payload": {"mimeType": "text/plain", "headers": hs, "body": {"data": _b64(text)}}}


# The inbox, newest first (as Gmail lists it).
INBOX = [
    _mail("m-leo", "thread-l", "leo@lead.test", "Count me in.", 0.4, In_Reply_To="<s-leo@us.test>"),
    _mail("m-own", "thread-x", f"Us <{OWN}>", "A note to self", 0.5),
    _mail("m-stranger", "thread-y", "x@elsewhere.test", "Buy our widgets", 0.6),
    _mail("m-dana", "thread-d", "dana@lead.test", "What would it cost?", 0.7, In_Reply_To="<s-dana@us.test>"),
    _mail("m-ann", "thread-n", "ann@lead.test", "Yes please", 0.8, In_Reply_To="<s-ann@us.test>"),
    _mail("m-ben", "thread-z", "mailer-daemon@googlemail.com", "Undeliverable. Original: <s-ben@us.test>", 0.9,
          subject="Delivery Status Notification (Failure)"),
    _mail("m-uma", "thread-u", "uma@lead.test", "Please remove me from your list.", 1, In_Reply_To="<s-uma@us.test>"),
    _mail("m-olga", "thread-o", "olga@lead.test", "I am away until Monday.", 1.2, In_Reply_To="<s-olga@us.test>",
          Auto_Submitted="auto-replied"),
    _mail("m-sam", "thread-new", "sam@lead.test", "Hello, who is this?", 1.5),
    _mail("m-tom", "thread-t", "tom@lead.test", "Sounds interesting.", 2),
    _mail("m-priya", "thread-a", "Priya <Priya@Lead.test>", "Yes, let's talk next week.\n\nOn Mon, Us wrote:\n> Hi",
          3, In_Reply_To="<s-priya@us.test>", Message_ID="<r-priya@lead.test>"),
]
THREADS = {  # thread-a: our answer to Priya, two days after her reply
    "thread-a": [{"id": "m-priya", "labelIds": ["INBOX"], "internalDate": str(NOW - 3 * DAY)},
                 {"id": "m-answer", "labelIds": ["SENT"], "internalDate": str(NOW - 1 * DAY)}],
}


class FakeGmail:
    def __init__(self):
        self.fetched: list[str] = []
        self.queries: list[str] = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        assert req.method in ("GET", "POST")
        if req.url.host == "oauth2.googleapis.com":
            assert b"refresh-token-from-js" in req.content
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        assert req.method == "GET", "only GET calls may reach Gmail"
        path = req.url.path.removeprefix("/gmail/v1/users/me")
        if path == "/messages":
            self.queries.append(req.url.params["q"])
            return httpx.Response(200, json={"messages": [{"id": m["id"]} for m in INBOX]})
        if path.startswith("/messages/"):
            gid = path.rsplit("/", 1)[1]
            self.fetched.append(gid)
            return httpx.Response(200, json=next(m for m in INBOX if m["id"] == gid))
        if path.startswith("/threads/"):
            return httpx.Response(200, json={"messages": THREADS.get(path.rsplit("/", 1)[1], [])})
        return httpx.Response(404, json={})


async def _seed(dsn):
    conn = await asyncpg.connect(dsn)
    try:
        await conn.execute(SCHEMA)
        await conn.execute((MIGRATIONS / "006_gmail_connection.sql").read_text())
        await conn.execute((MIGRATIONS / "007_inbox_replies.sql").read_text())
        await conn.execute((MIGRATIONS / "007_inbox_replies.sql").read_text())  # safe to run twice
        await conn.execute("insert into gmail_connection (email, refresh_token) values ($1, $2)", OWN, SEALED)
        for name, (msgid, thread, status) in LEADS.items():
            company = await conn.fetchval(
                "insert into companies (name, domain, source) values ($1, $2, 'leadgen:search') returning id",
                f"{name} Co", f"{name.lower()}.test")
            contact = await conn.fetchval(
                "insert into contacts (company_id, name, email) values ($1, $2, $3) returning id",
                company, name, f"{name.lower()}@lead.test")
            email = await conn.fetchval(
                "insert into emails (contact_id, mailbox, subject, status, sent_at, message_id, gmail_thread_id)"
                " values ($1, $2, 'Hello', $3, now() - interval '7 days', $4, $5) returning id",
                contact, OWN, status, msgid, thread)
            if name == "Ann":  # the agent read and labelled this one itself
                await conn.execute(
                    "insert into replies (contact_id, email_id, received_at, label, body, message_id, gmail_message_id)"
                    " values ($1, $2, now() - interval '1 day', 'interested', 'Yes please', '<r-ann@lead.test>',"
                    " 'm-ann')", contact, email)
    finally:
        await conn.close()


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    with throwaway_postgres(tmp_path_factory.mktemp("pg")) as dsn:
        asyncio.run(_seed(dsn))
        fake = FakeGmail()
        with pytest.MonkeyPatch.context() as mp:
            mp.setenv("DATABASE_URL", dsn)
            mp.setenv("SUPABASE_URL", "https://example.supabase.co")
            mp.setenv("SUPABASE_JWT_SECRET", SECRET)
            mp.setenv("GOOGLE_CLIENT_ID", "client-id")
            mp.setenv("GOOGLE_CLIENT_SECRET", GOOGLE_SECRET)
            mp.setattr(data, "_pool", None)  # a new pool, on this database
            mp.setattr(data, "_inbox", {"ready": False, "checked": 0.0})
            mp.setattr(gmail, "client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(fake)))
            gmail.forget_token()
            with TestClient(app) as c:  # one event loop for every request, so the pool can be reused
                first = c.post("/inbox/check", headers=_auth())
                yield {"client": c, "dsn": dsn, "gmail": fake, "first": first}


def _auth():
    claims = {"sub": "u1", "email": "ana@team.test", "aud": "authenticated", "exp": int(time.time()) + 60,
              "app_metadata": {"role": "employee"}}
    return {"Authorization": f"Bearer {jwt.encode(claims, SECRET, algorithm='HS256')}"}


def _get(env, path):
    res = env["client"].get(path, headers=_auth())
    assert res.status_code == 200, res.text
    return res.json()


def _db(env, sql, *args):
    async def go():
        conn = await asyncpg.connect(env["dsn"])
        try:
            return await conn.fetch(sql, *args)
        finally:
            await conn.close()

    return asyncio.run(go())


def _by_name(positive):
    return {g: [r["name"] for r in items] for g, items in positive.items() if isinstance(items, list)}


def test_the_check_reads_each_message_once(env):
    res = env["first"]
    assert res.status_code == 200, res.text
    # m-ann is the agent's already: never fetched. The other nine are looked at, oldest first.
    assert res.json() == {"checked": 11, "newReplies": 5, "processed": 10, "remaining": 0, "rechecked": 0,
                          "followUpsChecked": 5}
    assert "m-ann" not in env["gmail"].fetched and env["gmail"].fetched[0] == "m-priya"
    assert env["gmail"].queries[0].startswith("in:inbox after:")
    outcomes = {r["gmail_message_id"]: r["outcome"] for r in _db(env, "select * from inbox_seen")}
    assert outcomes == {"m-leo": "not_reply", "m-own": "own", "m-stranger": "not_reply", "m-dana": "reply", "m-ben": "bounce",
                        "m-uma": "reply", "m-olga": "reply", "m-sam": "reply", "m-tom": "reply", "m-priya": "reply"}
    stored = {r["gmail_message_id"]: (r["match_method"], r["auto_label"]) for r in _db(env, "select * from inbox_replies")}
    assert stored == {"m-priya": ("header", None), "m-tom": ("thread", None), "m-sam": ("sender", None),
                      "m-olga": ("header", "ooo"), "m-uma": ("header", None), "m-ben": ("header", "bounce"),
                      "m-dana": ("header", None)}


def test_a_second_check_reads_nothing_new(env):
    before = len(env["gmail"].fetched)
    res = env["client"].post("/inbox/check", headers=_auth())
    assert res.status_code == 200 and res.json()["processed"] == 0 and res.json()["newReplies"] == 0
    # No email of ours was recorded since, so nothing judged "not a reply" is looked at again either.
    assert res.json()["rechecked"] == 0 and len(env["gmail"].fetched) == before


def test_positive_leads_groups(env):
    # The agent stores Dana's mail after we did: from now on it is shown once, as the agent's (a question).
    _db(env, "insert into replies (contact_id, email_id, received_at, label, body, gmail_message_id) "
             "select contact_id, email_id, received_at, 'question', body, gmail_message_id from inbox_replies "
             "where gmail_message_id = 'm-dana'")
    res = _get(env, "/leads/positive")
    groups = _by_name(res)
    assert groups["positive"] == ["Ann"]
    assert sorted(groups["review"]) == ["Priya", "Sam", "Tom"]
    assert groups["questions"] == ["Dana"] and groups["unsubscribe"] == ["Uma"] and groups["notInterested"] == []
    reasons = {r["name"]: r["reviewReason"] for r in res["review"]}
    assert "sender's address only" in reasons["Sam"] and "not labelled yet" in reasons["Tom"]
    review = {r["name"]: r for r in res["review"]}
    assert review["Priya"]["followUp"] == "replied" and review["Tom"]["followUp"] == "unknown"
    assert review["Priya"]["replySource"] == "inbox" and review["Priya"]["source"] == "search"  # the lead's source kept
    assert review["Priya"]["preview"] == "Yes, let's talk next week."  # quoted mail left out
    # Responded: Priya, Tom, Uma, Ann, Dana. Not Sam (sender only), not Olga (out of office), not Ben (bounced).
    assert res["repliedLeads"] == 5


def test_lead_statuses(env):
    status = {r["name"]: r["status"] for r in _get(env, "/leads?limit=50")["items"]}
    assert status == {"Priya": "Responded", "Tom": "Responded", "Sam": "Sent", "Olga": "Sent", "Uma": "Responded",
                      "Ben": "Bounced", "Ann": "Responded", "Dana": "Responded"}


def test_a_lead_read_from_gmail_opens_its_reply_in_history(env):
    priya = next(r for r in _get(env, "/leads/positive")["review"] if r["name"] == "Priya")
    lead = _get(env, f"/leads/{priya['id']}")
    assert lead["conversation"] == {"type": "reply", "id": priya["replyId"]}
    sent = _db(env, "select e.id from emails e join contacts c on c.id = e.contact_id where c.name = 'Priya'")[0]["id"]
    reply = _get(env, f"/emails/replies/{priya['replyId']}")
    assert reply["replySource"] == "inbox" and reply["senderEmail"] == "priya@lead.test"
    assert reply["originalEmail"]["id"] == str(sent)  # the email of ours it answers
    assert lead["replySource"] == "inbox" and lead["replyGroup"] == "review"
    assert lead["latestReply"]["text"] == "Yes, let's talk next week."


def test_a_persons_label_moves_the_lead_and_can_be_undone(env):
    c = env["client"]
    tom = next(r for r in _get(env, "/leads/positive")["review"] if r["name"] == "Tom")
    body = {"source": "inbox", "replyId": tom["replyId"], "label": "interested"}
    assert c.post("/inbox/label", headers=_auth(), json=body).json() == {"ok": True}
    res = _get(env, "/leads/positive")
    assert sorted(_by_name(res)["positive"]) == ["Ann", "Tom"]
    assert next(r for r in res["positive"] if r["name"] == "Tom")["labelledByPerson"] is True
    assert _db(env, "select labelled_by from reply_labels")[0]["labelled_by"] == "ana@team.test"
    assert c.post("/inbox/label", headers=_auth(), json={**body, "label": None}).status_code == 200
    assert "Tom" in _by_name(_get(env, "/leads/positive"))["review"]


def test_a_persons_label_wins_over_the_agents(env):
    c = env["client"]
    ann = _get(env, "/leads/positive")["positive"][0]
    body = {"source": "agent", "replyId": ann["replyId"], "label": "not_interested"}
    assert c.post("/inbox/label", headers=_auth(), json=body).status_code == 200
    res = _get(env, "/leads/positive")
    assert _by_name(res)["notInterested"] == ["Ann"] and "Ann" not in _by_name(res)["positive"]
    lead = _get(env, f"/leads/{ann['id']}")
    assert lead["replyLabel"] == "not_interested" and lead["originalLabel"] == "interested"
    assert lead["labelledBy"]["by"] == "ana@team.test"
    # The agent's own row is left as it was.
    assert _db(env, "select label from replies where gmail_message_id = 'm-ann'")[0]["label"] == "interested"
    c.post("/inbox/label", headers=_auth(), json={**body, "label": None})


def test_label_for_a_reply_that_does_not_exist(env):
    body = {"source": "inbox", "replyId": "0b6b0f90-3f0e-4b8a-9c6d-2e1f0a9b8c7d", "label": "interested"}
    res = env["client"].post("/inbox/label", headers=_auth(), json=body)
    assert res.status_code == 404


def test_nothing_was_written_to_the_agents_tables(env):
    # emails untouched, no email_events table even exists here (any write to it would have failed the check), and
    # the only replies rows are the ones this test inserted on the agent's behalf.
    assert [r["gmail_message_id"] for r in _db(env, "select gmail_message_id from replies order by 1")] == [
        "m-ann", "m-dana"]
    assert _db(env, "select count(*) as n from emails where status <> 'sent'")[0]["n"] == 0


def test_a_reply_that_came_before_its_lead_is_found_later(env):
    # Leo's reply was read before Leo was in the database: "not a reply". Now his lead and our email are recorded
    # (as the test-lead guide does by hand), and the next check finds the reply without any reset.
    _db(env, """with co as (insert into companies (name, domain, source) values ('Leo Co', 'leo.test', 'leadgen:search')
                            returning id),
                     ct as (insert into contacts (company_id, name, email) select id, 'Leo', 'leo@lead.test' from co
                            returning id)
                insert into emails (contact_id, mailbox, subject, status, sent_at, message_id, gmail_thread_id)
                select id, 'us@us.test', 'Hello', 'sent', now() - interval '7 days', '<s-leo@us.test>', 'thread-l'
                from ct""")
    res = env["client"].post("/inbox/check", headers=_auth()).json()
    # Looked at again: Leo's reply (now a reply) and the stranger's mail (still not one); our own mail never.
    assert res["rechecked"] == 2 and res["newReplies"] == 1 and res["processed"] == 0
    outcomes = {r["gmail_message_id"]: r["outcome"] for r in _db(env, "select * from inbox_seen")}
    assert outcomes["m-leo"] == "reply" and outcomes["m-stranger"] == "not_reply"
    assert "Leo" in _by_name(_get(env, "/leads/positive"))["review"]
    # Nothing new was recorded since: the stranger's mail is not looked at again on the next check.
    assert env["client"].post("/inbox/check", headers=_auth()).json()["rechecked"] == 0


def test_history_lists_both_kinds_of_reply_once(env):
    res = _get(env, "/emails/replies?limit=200")
    by_source = {}
    for r in res["items"]:
        by_source.setdefault(r["replySource"], set()).add(r["senderName"])
    # Dana's mail is in both places: listed once, as the agent's. Our own and the stranger's mail: nowhere.
    assert by_source == {"inbox": {"Priya", "Tom", "Sam", "Olga", "Uma", "Ben", "Leo"}, "agent": {"Ann", "Dana"}}
    assert res["total"] == 9 and sorted(r["number"] for r in res["items"]) == list(range(1, 10))
    # Not labelled yet: the replies read from Gmail that no person or rule has labelled.
    unlabelled = {r["senderName"] for r in _get(env, "/emails/replies?label=unclassified&limit=200")["items"]}
    assert unlabelled == {"Priya", "Tom", "Sam", "Uma", "Leo"}
    # From people: everything except the out-of-office and the bounce.
    human = {r["senderName"] for r in _get(env, "/emails/replies?label=human&limit=200")["items"]}
    assert human == {"Priya", "Tom", "Sam", "Uma", "Leo", "Ann", "Dana"}


def test_a_sent_email_links_to_the_reply_read_from_gmail(env):
    sent = {r["to"]: r for r in _get(env, "/emails/sent?limit=200")["items"]}
    priya_reply = _db(env, "select id from inbox_replies where gmail_message_id = 'm-priya'")[0]["id"]
    assert sent["priya@lead.test"]["replyId"] == str(priya_reply)
    assert sent["sam@lead.test"]["replyId"] is None  # matched by sender only: not proof it answers this email
    assert _get(env, f"/emails/sent/{sent['priya@lead.test']['id']}")["replyId"] == str(priya_reply)
