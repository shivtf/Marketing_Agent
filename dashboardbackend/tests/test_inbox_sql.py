"""The inbox check and Positive Leads against a REAL Postgres, with Gmail faked. Nothing here touches Supabase or Google.

The database gets a minimal copy of the mail agent's tables plus this project's own migrations 006 and 007, run from
their files (and the indexes of 008, and 012 for the do-not-email list). The agent only sends, so every reply here is one the backend read from Gmail. Gmail is an httpx.MockTransport serving the made-up inbox below. Every lead and message is fake.

    Lead          Our email                   In the inbox                                   Expected
    ------------  --------------------------  ---------------------------------------------  -----------------------------
    Priya         <s-priya@us.test>, thread A  "Yes, let's talk" In-Reply-To our email; we     Positive (keyword score),
                                               answered later in thread A                     Responded, follow-up replied
    Tom           thread T                     "Sounds interesting" in thread T, no headers   Needs review (score 0.65),
                                                                                              Responded
    Sam           thread S                     "Hello, who is this?" from Sam's address, in   Questions (scored like any
                                                   another thread                                 reply), Responded
    Olga          <s-olga@us.test>             out-of-office (Auto-Submitted)                 not listed, not Responded
    Uma           <s-uma@us.test>              "Please remove me from your list"              Unsubscribe group
    Ben           <s-ben@us.test>              mailer-daemon notice quoting our Message-ID    Bounced
    Ann           <s-ann@us.test>              "Yes please"                                   Positive (keyword score)
    Dana          <s-dana@us.test>             "What would it cost?"; a person labels it no   Questions, then Not interested
    Leo           (added only after the check)  "Count me in" In-Reply-To <s-leo@us.test>       not a reply at first; found by
                                                                                              the next check once added:
                                                                                              Positive
    -             -                            our own mail, a stranger's mail                stored nowhere
"""

import asyncio
import base64
import json
import pathlib
import secrets
import time

import asyncpg
import httpx
import jwt
import pytest
from conftest import throwaway_postgres
from fastapi.testclient import TestClient

from app import data, gmail, reply_rules
from app.main import app

SECRET = secrets.token_hex(32)  # signs fake test tokens only
MIGRATIONS = pathlib.Path(__file__).parent.parent / "migrations"
# The dashboard's own encrypt() output (see test_inbox.py), so the check decrypts what the dashboard really saves.
SEALED = "v1.w3raedxOR6B7GWiN.WFcNWIejCaNdUz-cYcmsLg.1xRAUJR4iK6iLFXIh0FF_Tv-VUb-3ilL"
GOOGLE_SECRET = "js-test-client-secret"
OWN = "us@us.test"

# The agent's tables: only the columns the dashboard reads (it has no replies of its own: it only sends).
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
-- The agent's do-not-email list (agent migration 0002; email_hash there uses pgcrypto's digest, the same sha256).
create table suppression_list (email_hash text primary key, reason text not null,
  created_at timestamptz not null default now());
create function email_hash(addr text) returns text language sql immutable as
  $$ select encode(sha256(convert_to(lower(trim(addr)), 'UTF8')), 'hex') $$;
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
    # Archived (no INBOX label): still read.
    _mail("m-ann", "thread-n", "ann@lead.test", "Yes please", 0.8, labels=("IMPORTANT",), In_Reply_To="<s-ann@us.test>"),
    # Our own sent mail: never even fetched (the search leaves it out).
    _mail("m-sent", "thread-a", f"Us <{OWN}>", "Thanks Priya", 0.85, labels=("SENT",)),
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


# The Gmail search terms the backend uses, applied like Gmail does (dates are left out: every message is recent).
_IN = {"inbox": "INBOX", "sent": "SENT", "drafts": "DRAFT", "chats": "CHAT"}


def _matches(msg, query):
    for term in query.split():
        neg, term = term.startswith("-"), term.lstrip("-")
        if term.startswith("in:"):
            if (_IN[term[3:]] in msg["labelIds"]) == neg:
                return False
    return True


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
            q = req.url.params["q"]
            self.queries.append(q)
            return httpx.Response(200, json={"messages": [{"id": m["id"]} for m in INBOX if _matches(m, q)]})
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
        await conn.execute((MIGRATIONS / "008_inbox_indexes.sql").read_text())
        await conn.execute((MIGRATIONS / "008_inbox_indexes.sql").read_text())  # safe to run twice
        await conn.execute((MIGRATIONS / "012_unsubscribe_suppression.sql").read_text())
        await conn.execute((MIGRATIONS / "012_unsubscribe_suppression.sql").read_text())  # safe to run twice
        await conn.execute((MIGRATIONS / "013_reply_scores.sql").read_text())
        await conn.execute((MIGRATIONS / "013_reply_scores.sql").read_text())  # safe to run twice
        await conn.execute("insert into gmail_connection (email, refresh_token) values ($1, $2)", OWN, SEALED)
        for name, (msgid, thread, status) in LEADS.items():
            company = await conn.fetchval(
                "insert into companies (name, domain, source) values ($1, $2, 'leadgen:search') returning id",
                f"{name} Co", f"{name.lower()}.test")
            contact = await conn.fetchval(
                "insert into contacts (company_id, name, email) values ($1, $2, $3) returning id",
                company, name, f"{name.lower()}@lead.test")
            await conn.execute(
                "insert into emails (contact_id, mailbox, subject, status, sent_at, message_id, gmail_thread_id)"
                " values ($1, $2, 'Hello', $3, now() - interval '7 days', $4, $5)",
                contact, OWN, status, msgid, thread)
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
    # All eleven are looked at, oldest first.
    body = res.json()
    assert {k: v for k, v in body.items() if k != "since"} == {
        "checked": 11, "newReplies": 6, "processed": 11, "remaining": 0, "rechecked": 0, "followUpsChecked": 6,
        "repliesWithoutLead": 0}
    assert body["since"].startswith(_db(env, "select min(sent_at)::date::text as d from emails")[0]["d"])
    assert len(env["gmail"].fetched) == 11 and env["gmail"].fetched[0] == "m-priya"
    assert env["gmail"].queries[0].startswith("-in:sent -in:drafts -in:chats after:")
    assert "m-sent" not in env["gmail"].fetched
    outcomes = {r["gmail_message_id"]: r["outcome"] for r in _db(env, "select * from inbox_seen")}
    assert outcomes == {"m-leo": "not_reply", "m-own": "own", "m-stranger": "not_reply", "m-dana": "reply", "m-ann": "reply",
                        "m-ben": "bounce", "m-uma": "reply", "m-olga": "reply", "m-sam": "reply", "m-tom": "reply",
                        "m-priya": "reply"}
    stored = {r["gmail_message_id"]: (r["match_method"], r["auto_label"]) for r in _db(env, "select * from inbox_replies")}
    assert stored == {"m-priya": ("header", None), "m-tom": ("thread", None), "m-sam": ("sender", None),
                      "m-olga": ("header", "ooo"), "m-uma": ("header", None), "m-ben": ("header", "bounce"),
                      "m-dana": ("header", None), "m-ann": ("header", None)}


def test_a_second_check_reads_nothing_new(env):
    before = len(env["gmail"].fetched)
    res = env["client"].post("/inbox/check", headers=_auth())
    assert res.status_code == 200 and res.json()["processed"] == 0 and res.json()["newReplies"] == 0
    # No email of ours was recorded since, so nothing judged "not a reply" is looked at again either.
    assert res.json()["rechecked"] == 0 and len(env["gmail"].fetched) == before


def test_the_check_saves_each_replys_score(env):
    # Runs before any Positive Leads load: these scores come from the check itself, not from the page.
    rows = _db(env, "select c.name, s.auto_label, s.score_data, s.scored_with from inbox_replies s"
                    " left join contacts c on c.id = s.contact_id")
    people = [r for r in rows if r["auto_label"] is None]
    assert people and all(r["scored_with"] == reply_rules.RULES_VERSION for r in people)
    priya = next(json.loads(r["score_data"]) for r in people if r["name"] == "Priya")
    assert priya["score"] == 0.75 and priya["preview"] == "Yes, let's talk next week."
    # Out-of-office and bounces aren't listed on Positive Leads, so they aren't scored.
    assert all(r["score_data"] is None and r["scored_with"] is None for r in rows if r["auto_label"])


def test_positive_leads_groups(env):
    res = _get(env, "/leads/positive")
    groups = _by_name(res)
    # Nobody has labelled anything yet: the keyword score sorts them (Uma's seems to ask to stop). Sam wrote from his
    # address in a new thread: scored like any reply.
    assert sorted(groups["positive"]) == ["Ann", "Priya"]
    assert groups["review"] == ["Tom"]
    assert sorted(groups["questions"]) == ["Dana", "Sam"]
    assert groups["unsubscribe"] == ["Uma"] and groups["notInterested"] == []
    reasons = {r["name"]: r["reviewReason"] for r in res["review"]}
    assert reasons == {"Tom": "Score 0.65: no clear yes or no"}
    positive = {r["name"]: r for r in res["positive"]}
    assert positive["Priya"]["followUp"] == "replied" and {r["followUp"] for r in res["review"]} == {"waiting"}
    assert positive["Priya"]["source"] == "search"  # the lead's source kept
    # Scored on what she wrote: our quoted email ("On Mon, Us wrote: > Hi") is left out.
    assert positive["Priya"]["preview"] == "Yes, let's talk next week." and positive["Priya"]["score"] == 0.75
    # Responded: Priya, Tom, Sam, Uma, Ann, Dana. Not Olga (out of office), not Ben (bounced).
    assert res["repliedLeads"] == 6


def test_lead_statuses(env):
    status = {r["name"]: r["status"] for r in _get(env, "/leads?limit=50")["items"]}
    assert status == {"Priya": "Responded", "Tom": "Responded", "Sam": "Responded", "Olga": "Sent", "Uma": "Responded",
                      "Ben": "Bounced", "Ann": "Responded", "Dana": "Responded"}


def test_a_lead_opens_its_reply(env):
    priya = next(r for r in _get(env, "/leads/positive")["positive"] if r["name"] == "Priya")
    lead = _get(env, f"/leads/{priya['leadId']}")
    assert lead["conversation"] == {"type": "reply", "id": priya["replyId"]}
    assert _get(env, f"/leads/by-reply/{priya['id']}") == lead  # the row's own reply is her only one
    sent = _db(env, "select e.id from emails e join contacts c on c.id = e.contact_id where c.name = 'Priya'")[0]["id"]
    reply = _get(env, f"/emails/replies/{priya['replyId']}")
    assert reply["senderEmail"] == "priya@lead.test" and reply["label"] is None
    assert reply["originalEmail"]["id"] == str(sent)  # the email of ours it answers
    assert lead["replyGroup"] == "positive" and lead["labelledBy"] is None and lead["score"] == 0.75
    assert lead["latestReply"]["text"] == "Yes, let's talk next week."


def test_a_persons_label_moves_the_lead_and_can_be_undone(env):
    c = env["client"]
    tom = next(r for r in _get(env, "/leads/positive")["review"] if r["name"] == "Tom")
    body = {"replyId": tom["replyId"], "label": "interested"}
    assert c.post("/inbox/label", headers=_auth(), json=body).json() == {"ok": True}
    res = _get(env, "/leads/positive")
    assert sorted(_by_name(res)["positive"]) == ["Ann", "Priya", "Tom"]
    assert next(r for r in res["positive"] if r["name"] == "Tom")["labelledByPerson"] is True
    assert _db(env, "select labelled_by from reply_labels")[0]["labelled_by"] == "ana@team.test"
    assert c.post("/inbox/label", headers=_auth(), json={**body, "label": None}).status_code == 200
    assert "Tom" in _by_name(_get(env, "/leads/positive"))["review"]


def test_a_labelled_reply_shows_who_labelled_it(env):
    c = env["client"]
    dana = next(r for r in _get(env, "/leads/positive")["questions"] if r["name"] == "Dana")
    body = {"replyId": dana["replyId"], "label": "not_interested"}
    assert c.post("/inbox/label", headers=_auth(), json=body).status_code == 200
    assert _by_name(_get(env, "/leads/positive"))["notInterested"] == ["Dana"]
    lead = _get(env, f"/leads/by-reply/{dana['id']}")
    assert lead["replyLabel"] == "not_interested" and lead["replyGroup"] == "notInterested"
    assert lead["labelledBy"]["by"] == "ana@team.test"
    assert _get(env, f"/emails/replies/{dana['replyId']}")["label"] == "not_interested"
    # The label report (app/label_report.py) reads it back with its own query: "What would it cost?" is a question to
    # the keywords, a no to the person.
    from app import label_report

    rows = [dict(r) for r in _db(env, label_report._SQL, list(label_report.LABEL_GROUP))]
    report = label_report.disagreements(rows)
    assert [(i["from"], i["labelled"], i["keywords"]) for i in report["other"]] == [
        ("dana@lead.test", "notInterested", "questions")]
    c.post("/inbox/label", headers=_auth(), json={**body, "label": None})


def test_an_out_of_office_label_can_be_taken_back(env):
    # Labelled out of office in the drawer: off Positive Leads, but the drawer still opens it, so it can be undone.
    c = env["client"]
    tom = next(r for r in _get(env, "/leads/positive")["review"] if r["name"] == "Tom")
    body = {"replyId": tom["replyId"], "label": "ooo"}
    assert c.post("/inbox/label", headers=_auth(), json=body).status_code == 200
    assert "Tom" not in sum(_by_name(_get(env, "/leads/positive")).values(), [])
    lead = _get(env, f"/leads/by-reply/{tom['id']}")
    assert lead["replyLabel"] == "ooo" and lead["replyGroup"] is None and lead["labelledBy"]["by"] == "ana@team.test"
    assert lead["latestReply"]["text"] == "Sounds interesting."
    assert c.post("/inbox/label", headers=_auth(), json={**body, "label": None}).status_code == 200
    assert "Tom" in _by_name(_get(env, "/leads/positive"))["review"]
    # An automatic out-of-office (Olga's) opens too, and is never listed.
    olga = _db(env, "select id from inbox_replies where gmail_message_id = 'm-olga'")[0]["id"]
    lead = _get(env, f"/leads/by-reply/{olga}")
    assert lead["replyLabel"] == "ooo" and lead["replyGroup"] is None and lead["labelledBy"] is None


def test_label_for_a_reply_that_does_not_exist(env):
    body = {"replyId": "0b6b0f90-3f0e-4b8a-9c6d-2e1f0a9b8c7d", "label": "interested"}
    res = env["client"].post("/inbox/label", headers=_auth(), json=body)
    assert res.status_code == 404


def test_nothing_was_written_to_the_agents_tables(env):
    # emails untouched; no replies or email_events table even exists here (any write to one would have failed). Nobody
    # labelled a reply Unsubscribe, so nobody is on the do-not-email list either.
    assert _db(env, "select count(*) as n from emails where status <> 'sent'")[0]["n"] == 0
    assert _db(env, "select count(*) as n from suppression_list")[0]["n"] == 0


def _suppressed(env):
    return {r["reason"] for r in _db(env, "select reason from suppression_list")}, {
        r["email"]: r["s"] for r in _db(env, """select e as email, exists (select 1 from suppression_list
                                                  where email_hash = email_hash(e)) as s
                                                from unnest(array['uma@lead.test', 'ann@lead.test']) e""")}


def test_an_unsubscribe_label_stops_the_agent_emailing_them(env):
    c = env["client"]
    uma = next(r for r in _get(env, "/leads/positive")["unsubscribe"] if r["name"] == "Uma")
    # Only seen by the keywords so far: not on the list yet, and the drawer says so.
    assert _get(env, f"/leads/by-reply/{uma['id']}")["doNotEmail"] is False
    body = {"replyId": uma["replyId"], "label": "unsubscribe"}
    assert c.post("/inbox/label", headers=_auth(), json=body).json() == {"ok": True}
    assert _suppressed(env) == ({"unsubscribe"}, {"uma@lead.test": True, "ann@lead.test": False})
    assert _get(env, f"/leads/by-reply/{uma['id']}")["doNotEmail"] is True
    assert _db(env, "select added_by from dashboard_suppressions")[0]["added_by"] == "ana@team.test"
    # Saving it again changes nothing; another label takes it back off the list.
    assert c.post("/inbox/label", headers=_auth(), json=body).status_code == 200
    assert c.post("/inbox/label", headers=_auth(), json={**body, "label": "not_interested"}).status_code == 200
    assert _suppressed(env)[1]["uma@lead.test"] is False
    assert _db(env, "select count(*) as n from dashboard_suppressions")[0]["n"] == 0
    c.post("/inbox/label", headers=_auth(), json={**body, "label": None})


def test_taking_the_label_back_never_lifts_the_agents_own_entry(env):
    c = env["client"]
    # Ann's address bounced earlier: the agent put it on the list itself.
    _db(env, "insert into suppression_list (email_hash, reason) values (email_hash('Ann@Lead.test'), 'bounce')")
    ann = next(r for r in _get(env, "/leads/positive")["positive"] if r["name"] == "Ann")
    body = {"replyId": ann["replyId"], "label": "unsubscribe"}
    assert c.post("/inbox/label", headers=_auth(), json=body).status_code == 200
    assert c.post("/inbox/label", headers=_auth(), json={**body, "label": None}).status_code == 200
    assert _suppressed(env) == ({"bounce"}, {"uma@lead.test": False, "ann@lead.test": True})
    _db(env, "delete from suppression_list")


def test_the_functions_act_only_on_a_labelled_reply(env):
    tom = _db(env, "select id from inbox_replies where gmail_message_id = 'm-tom'")[0]["id"]
    assert _db(env, "select dashboard_suppress($1, 'x') as n", tom)[0]["n"] == 0  # not labelled unsubscribe
    assert _db(env, "select count(*) as n from suppression_list")[0]["n"] == 0


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
    assert "Leo" in _by_name(_get(env, "/leads/positive"))["positive"]  # "Count me in."
    # Nothing new was recorded since: the stranger's mail is not looked at again on the next check.
    assert env["client"].post("/inbox/check", headers=_auth()).json()["rechecked"] == 0


def test_a_sent_email_links_to_the_reply_read_from_gmail(env):
    sent = {r["to"]: r for r in _get(env, "/emails/sent?limit=200")["items"]}
    priya_reply = _db(env, "select id from inbox_replies where gmail_message_id = 'm-priya'")[0]["id"]
    assert sent["priya@lead.test"]["replyId"] == str(priya_reply)
    assert sent["sam@lead.test"]["replyId"] is None  # matched by sender only: not proof it answers this email
    # Ben's email bounced (the notice was read from Gmail): Failed here too, as his lead says Bounced.
    assert sent["ben@lead.test"]["deliveryStatus"] == "Failed" and sent["priya@lead.test"]["deliveryStatus"] == "Sent"
    # A bounce notice or an out-of-office is not a reply: Ben's and Olga's emails show none.
    assert sent["ben@lead.test"]["replyId"] is None and sent["olga@lead.test"]["replyId"] is None
    assert _get(env, "/emails/sent?limit=200")["failed"] == 1
    assert _get(env, f"/emails/sent/{sent['priya@lead.test']['id']}")["replyId"] == str(priya_reply)


def test_a_reply_whose_saved_copy_was_deleted_is_read_again(env):
    # e.g. a test-lead cleanup deleted the saved reply but not the "already looked at" record: it must come back.
    _db(env, "delete from inbox_replies where gmail_message_id = 'm-priya'")
    assert "Priya" not in _by_name(_get(env, "/leads/positive"))["positive"]
    before = len(env["gmail"].fetched)
    res = env["client"].post("/inbox/check", headers=_auth()).json()
    assert res["processed"] == 1 and res["newReplies"] == 1 and env["gmail"].fetched[before:] == ["m-priya"]
    assert "Priya" in _by_name(_get(env, "/leads/positive"))["positive"]
    # Read once more only while it is missing: the next check fetches nothing.
    assert env["client"].post("/inbox/check", headers=_auth()).json()["processed"] == 0


def test_the_check_counts_saved_replies_whose_lead_is_gone(env):
    _db(env, """insert into inbox_replies (gmail_message_id, contact_id, match_method, from_email, body, received_at)
                values ('m-gone', gen_random_uuid(), 'header', 'gone@lead.test', 'Yes!', now())""")
    _db(env, "insert into inbox_seen (gmail_message_id, outcome) values ('m-gone', 'reply')")
    res = env["client"].post("/inbox/check", headers=_auth()).json()
    assert res["repliesWithoutLead"] == 1  # not on Positive Leads (no lead to list it under), but reported
    _db(env, "delete from inbox_replies where gmail_message_id = 'm-gone'")


def test_a_new_email_adds_a_row_and_the_old_one_stays(env):
    # Tom's first email was "Sounds interesting." (Needs review). He writes again from his address, in a new thread.
    _db(env, """insert into inbox_replies (gmail_message_id, contact_id, email_id, match_method, from_email, body,
                                           received_at)
                select 'm-tom-2', s.contact_id, s.email_id, 'sender', s.from_email, 'Sounds great, let''s talk.', now()
                from inbox_replies s where s.gmail_message_id = 'm-tom'""")
    res = _get(env, "/leads/positive")
    toms = {g: [r for r in items if r["name"] == "Tom"] for g, items in res.items() if isinstance(items, list)}
    assert [r["followUp"] for r in toms["review"]] == ["later"]  # the old one stays, no longer the one waiting
    assert [r["followUp"] for r in toms["positive"]] == ["waiting"]  # the new one is added
    new = toms["positive"][0]
    assert new["leadId"] == toms["review"][0]["leadId"] and new["id"] != toms["review"][0]["id"]
    detail = _get(env, f"/leads/by-reply/{new['id']}")
    assert detail["latestReply"]["text"] == "Sounds great, let's talk." and detail["replyGroup"] == "positive"
    assert _get(env, f"/leads/by-reply/{toms['review'][0]['id']}")["latestReply"]["text"] == "Sounds interesting."
    assert env["client"].get("/leads/by-reply/not-a-uuid", headers=_auth()).status_code == 404
    _db(env, "delete from inbox_replies where gmail_message_id = 'm-tom-2'")


def test_a_colleagues_reply_shows_who_wrote_it(env):
    # Raj, Priya's colleague, answers in her conversation: it is her lead's reply, written by Raj.
    _db(env, """insert into inbox_replies (gmail_message_id, gmail_thread_id, contact_id, email_id, match_method,
                                           from_email, body, received_at)
                select 'm-raj', 'thread-a', s.contact_id, s.email_id, 'thread', 'raj@lead.test', 'Yes, let''s talk.', now()
                from inbox_replies s where s.gmail_message_id = 'm-priya'""")
    raj = _db(env, "select id from inbox_replies where gmail_message_id = 'm-raj'")[0]["id"]
    reply = _get(env, f"/emails/replies/{raj}")
    assert (reply["senderName"], reply["senderEmail"]) == ("raj@lead.test", "raj@lead.test")
    priya = _db(env, "select id from inbox_replies where gmail_message_id = 'm-priya'")[0]["id"]
    assert _get(env, f"/emails/replies/{priya}")["senderName"] == "Priya"  # the lead herself: her name
    _db(env, "delete from inbox_replies where gmail_message_id = 'm-raj'")
