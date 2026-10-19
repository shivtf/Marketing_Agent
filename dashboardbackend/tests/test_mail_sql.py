"""The mail queries against a REAL Postgres, with made-up test leads. Nothing here touches Supabase.

test_data.py fakes the database, so it checks the Python but not the SQL. These tests run the real SQL of
/leads/positive, /leads/stats and /leads/{id} (app/data.py) on a throwaway Postgres that is created in a temporary
folder for this test run and deleted afterwards. The tables are a minimal copy of the Marketing Agent's (only the
columns the dashboard reads) plus this project's migration 007, and every lead below is fake. The agent only sends:
every reply is one the backend read from Gmail (inbox_replies), with the label a person gave it (reply_labels).

Needs the Postgres server programs (initdb, pg_ctl); the tests are skipped without them:
    sudo apt install postgresql

The test leads, one per case, and where each should show (Positive Leads tab / Dashboard status):

    Lead               Their emails and replies                                 Positive Leads    Dashboard
    -----------------  -------------------------------------------------------  ----------------  ----------
    Positive Priya     "Yes, let's talk", labelled interested                   Positive          Responded
    Answered Anna      labelled interested, and we answered in the thread       Positive          Responded
    Review Rahul       "Maybe", nobody has labelled it, no keyword              Needs review      Responded
    Keyword Kate       "Sounds great, send me some times", not labelled         Positive (score)  Responded
    Keyword Ken        "No thanks, we already work with an agency", unlabelled  Not interested    Responded
    Sender Sid         "Sounds great, let's talk" in a new thread (address)     Positive (score)  Responded
    Question Quinn     asked about pricing, labelled question                   Questions         Responded
    NotInterested Nina "No thanks", labelled not interested                     Not interested    Responded
    ChangedMind Carl   interested first, then "not now" (the last counts)       Not interested    Responded
    Unsubscribe Uma    "Please remove me from your list", not labelled          Unsubscribe       Responded
    OutOfOffice Olga   only an automatic out-of-office reply                    -                 Awaiting
    Silent Sam         emailed, no reply                                        -                 Awaiting
    Bounced Ben        the email bounced                                        -                 Bounced
    New Nora           not emailed yet                                          -                 Not Sent
    Waiting Co         (company only) qualified, waiting for a contact          -                 No Contact
    Rejected Co / Discovered Co  (company only) not in the pipeline             -                 not listed
"""

import asyncio
import pathlib
import secrets
import time

import asyncpg
import jwt
import pytest
from conftest import throwaway_postgres
from fastapi.testclient import TestClient

from app import data
from app.main import app

SECRET = secrets.token_hex(32)  # signs fake test tokens only

# Only the columns app/data.py reads.
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
  status text, sent_at timestamptz);
"""
MIGRATIONS = pathlib.Path(__file__).parent.parent / "migrations"

# name: (outreach email status or None = not emailed,
#        [(label: a person's, 'ooo' = automatic, None = not labelled; how it was matched; days ago; text)],
#        we answered in the Gmail conversation)
LEADS = {
    "Positive Priya": ("sent", [("interested", "header", 1, "Yes, let's talk next week.")], False),
    "Answered Anna": ("sent", [("interested", "thread", 3, "Sounds good, send me times.")], True),
    "Review Rahul": ("sent", [(None, "header", 1, "Maybe, depends on timing.")], False),
    "Keyword Kate": ("sent", [(None, "header", 1, "Sounds great, send me some times.")], False),
    "Keyword Ken": ("sent", [(None, "header", 1, "No thanks, we already work with an agency.")], False),
    "Sender Sid": ("sent", [(None, "sender", 1, "Sounds great, let's talk.")], False),
    "Question Quinn": ("sent", [("question", "header", 1, "What does it cost?")], False),
    "NotInterested Nina": ("sent", [("not_interested", "header", 1, "No thanks.")], False),
    "ChangedMind Carl": ("sent", [("interested", "header", 5, "Interested!"),
                                  ("not_interested", "header", 1, "Not now.")], False),
    "Unsubscribe Uma": ("sent", [(None, "header", 1, "Please remove me from your list.")], False),
    "OutOfOffice Olga": ("sent", [("ooo", "header", 1, "I am out of office until Monday.")], False),
    "Silent Sam": ("sent", [], False),
    "Bounced Ben": ("bounced", [], False),
    "New Nora": (None, [], False),
}


async def _seed(dsn: str) -> None:
    conn = await asyncpg.connect(dsn)
    try:
        await conn.execute(SCHEMA)
        await conn.execute((MIGRATIONS / "007_inbox_replies.sql").read_text())
        # Companies with no contact: one still in the pipeline (a lead), two that are not.
        await conn.execute("""insert into companies (name, domain, source, lead_status) values
            ('Waiting Co', 'waiting.test', 'leadgen:search', 'NEEDS_CONTACT'),
            ('Rejected Co', 'rejected.test', 'leadgen:search', 'REJECTED'),
            ('Discovered Co', 'discovered.test', 'leadgen:search', 'DISCOVERED')""")
        for name, (outreach, replies, answered) in LEADS.items():
            company = await conn.fetchval(
                "insert into companies (name, domain, source) values ($1, $2, 'leadgen:search') returning id",
                f"{name} Co", f"{name.split()[1].lower()}.test")
            contact = await conn.fetchval(
                "insert into contacts (company_id, name, email) values ($1, $2, $3) returning id",
                company, name, f"{name.split()[1].lower()}@test.invalid")
            if outreach is None:
                continue
            email = await conn.fetchval(
                "insert into emails (contact_id, mailbox, subject, status, sent_at)"
                " values ($1, 'us@test.invalid', 'Hello', $2, now() - interval '7 days') returning id",
                contact, outreach)
            for label, match, days, text in replies:
                reply = await conn.fetchval(
                    "insert into inbox_replies (gmail_message_id, email_id, contact_id, match_method, from_email, body,"
                    " received_at, auto_label, we_replied_at)"
                    " values (gen_random_uuid()::text, $1, $2, $3, $4, $5, now() - make_interval(days => $6), $7,"
                    " case when $8 then now() end) returning id",
                    email, contact, match, f"{name.split()[1].lower()}@test.invalid", text, days,
                    "ooo" if label == "ooo" else None, answered)
                if label and label != "ooo":
                    await conn.execute(
                        "insert into reply_labels (source, reply_id, label, labelled_by) values ('inbox', $1, $2, $3)",
                        reply, label, "ana@team.test")
    finally:
        await conn.close()


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    with throwaway_postgres(tmp_path_factory.mktemp("pg")) as dsn:  # conftest.py: skipped without Postgres
        asyncio.run(_seed(dsn))
        with pytest.MonkeyPatch.context() as mp:
            mp.setenv("DATABASE_URL", dsn)
            mp.setenv("SUPABASE_URL", "https://example.supabase.co")
            mp.setenv("SUPABASE_JWT_SECRET", SECRET)
            mp.setattr(data, "_pool", None)  # a new pool, on this database
            with TestClient(app) as c:  # one event loop for every request, so the pool can be reused
                c.app_state_dsn = dsn  # for tests that look at the database directly
                yield c


def _auth():
    claims = {"sub": "u1", "aud": "authenticated", "exp": int(time.time()) + 60, "app_metadata": {"role": "employee"}}
    return {"Authorization": f"Bearer {jwt.encode(claims, SECRET, algorithm='HS256')}"}


def _get(client, path):
    res = client.get(path, headers=_auth())
    assert res.status_code == 200, res.text
    return res.json()


def test_every_reply_lands_in_the_right_place(client):
    """The table at the top of this file, checked in one go."""
    res = _get(client, "/leads/positive")
    tabs = {lead["name"]: tab for tab in ("positive", "review", "questions", "notInterested", "unsubscribe")
            for lead in res[tab]}
    assert tabs == {
        "Positive Priya": "positive",
        "Answered Anna": "positive",
        "Keyword Kate": "positive",  # no label: the keyword score (1.0) decides
        "Review Rahul": "review",
        "Sender Sid": "positive",  # a new thread from his address: scored like any reply
        "Question Quinn": "questions",
        "NotInterested Nina": "notInterested",
        "ChangedMind Carl": "notInterested",  # their last reply says no
        "Keyword Ken": "notInterested",  # no label: the keyword score (0.0) decides
        "Unsubscribe Uma": "unsubscribe",
        # Not on the page: OutOfOffice Olga (automatic reply), Silent Sam, Bounced Ben, New Nora.
    }
    assert res["repliedLeads"] == 10  # everyone marked Responded in the table
    kate = next(lead for lead in res["positive"] if lead["name"] == "Keyword Kate")
    assert kate["score"] == 1.0 and [h["phrase"] for h in kate["scoreHits"]] == ["send me some times", "sounds great"]


def test_follow_up_column(client):
    res = _get(client, "/leads/positive")
    assert {lead["name"]: lead["followUp"] for lead in res["positive"]} == {
        "Positive Priya": "waiting", "Answered Anna": "replied", "Keyword Kate": "waiting", "Sender Sid": "waiting"}
    assert res["positive"][0]["name"] == "Positive Priya"  # still waiting for our answer: listed first
    assert {lead["followUp"] for lead in res["notInterested"]} == {"none"}  # a "no" needs no answer


def test_review_says_why(client):
    reasons = {lead["name"]: lead["reviewReason"] for lead in _get(client, "/leads/positive")["review"]}
    assert reasons == {"Review Rahul": "No keywords matched"}


def test_dashboard_counts(client):
    stats = _get(client, "/leads/stats")
    assert {k: stats[k] for k in ("total", "notSent", "noContact", "awaiting", "responded", "bounced")} == {
        "total": 15,
        "notSent": 1,  # New Nora
        "noContact": 1,  # Waiting Co (Rejected Co and Discovered Co are not leads)
        "awaiting": 2,  # OutOfOffice Olga (an automatic reply is not a response), Silent Sam
        "responded": 10,  # the same 10 as "Leads Replied" on Positive Leads
        "bounced": 1,  # Bounced Ben
    }


def test_each_lead_status(client):
    items = _get(client, "/leads?limit=200")["items"]
    status = {lead["name"]: lead["status"] for lead in items}
    responded = [n for n, (_, replies, _) in LEADS.items() if any(r[0] != "ooo" for r in replies)]
    assert status == {
        **{n: "Responded" for n in responded},
        "OutOfOffice Olga": "Sent",
        "Silent Sam": "Sent",
        "Bounced Ben": "Bounced",
        "New Nora": "Not Sent",
        "Waiting Co": "No Contact",
    }


def test_lead_is_judged_on_its_last_reply(client):
    carl = next(lead for lead in _get(client, "/leads?limit=200")["items"] if lead["name"] == "ChangedMind Carl")
    detail = _get(client, f"/leads/{carl['id']}")
    assert detail["latestReply"]["text"] == "Not now."


def test_lead_queries_use_the_indexes(client):
    # With sequential scans off, the planner picks an index whenever one fits: the reply lookups must find one
    # (migration 007's index on inbox_replies).
    async def plan():
        conn = await asyncpg.connect(client.app_state_dsn)
        try:
            await conn.execute("set enable_seqscan = off")
            return "\n".join(r[0] for r in await conn.fetch(
                "explain select 1 from inbox_replies s where s.contact_id = gen_random_uuid()"
                " order by received_at desc limit 1"))
        finally:
            await conn.close()

    assert "inbox_replies_contact_idx" in asyncio.run(plan())


def test_a_company_without_a_contact_opens_as_a_lead(client):
    waiting = next(lead for lead in _get(client, "/leads?status=no_contact")["items"])
    assert waiting["name"] == "Waiting Co"
    detail = _get(client, f"/leads/{waiting['id']}")
    assert detail["email"] is None and detail["conversation"] is None and detail["latestReply"] is None
    assert detail["companyUrl"] == "https://waiting.test" and detail["status"] == "No Contact"
