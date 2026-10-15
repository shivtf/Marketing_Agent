"""The mail queries against a REAL Postgres, with made-up test leads. Nothing here touches Supabase.

test_data.py fakes the database, so it checks the Python but not the SQL. These tests run the real SQL of
/leads/positive, /leads/stats and /leads/{id} (app/data.py) on a throwaway Postgres that is created in a temporary
folder for this test run and deleted afterwards. The tables are a minimal copy of the Marketing Agent's (only the
columns the dashboard reads), and every lead below is fake.

Needs the Postgres server programs (initdb, pg_ctl); the tests are skipped without them:
    sudo apt install postgresql

The test leads, one per case, and where each should show (Positive Leads tab / Dashboard status):

    Lead              Their emails and replies                             Positive Leads    Dashboard
    ----------------  ---------------------------------------------------  ----------------  ----------
    Positive Priya    "Yes, let's talk" (interested, sure)                 Positive          Responded
    Answered Anna     interested, and our answer was sent                  Positive          Responded
    Queued Quentin    interested, our answer approved but not sent         Positive          Responded
    Review Rahul      interested, but the classifier was not sure          Needs review      Responded
    Doubtful Dev      not interested, but the classifier was not sure      Needs review      Responded
    Question Quinn    asked about pricing (question)                       Questions         Responded
    NotInterested Nina "No thanks" (not interested, sure)                  -                 Responded
    ChangedMind Carl  interested first, then "not now" (the last counts)   -                 Responded
    Pending Paul      replied, not classified yet                          - (pending: 1)    Responded
    OutOfOffice Olga  only an automatic out-of-office reply                -                 Awaiting
    Silent Sam        emailed, no reply                                    -                 Awaiting
    Bounced Ben       the email bounced                                    -                 Bounced
    New Nora          not emailed yet                                      -                 Not Sent
"""

import asyncio
import glob
import secrets
import shutil
import subprocess
import time

import asyncpg
import jwt
import pytest
from fastapi.testclient import TestClient

from app import data
from app.main import app

SECRET = secrets.token_hex(32)  # signs fake test tokens only

# Only the columns app/data.py reads.
SCHEMA = """
create table companies (
  id uuid primary key default gen_random_uuid(), name text, domain text, source text, source_url text,
  project_summary text, industry text);
create table contacts (
  id uuid primary key default gen_random_uuid(), company_id uuid references companies, name text, email text,
  role text, collected_at timestamptz not null default now(), last_engaged_at timestamptz);
create table emails (
  id uuid primary key default gen_random_uuid(), contact_id uuid references contacts, mailbox text, subject text,
  status text, sent_at timestamptz, reply_id uuid);
create table replies (
  id uuid primary key default gen_random_uuid(), contact_id uuid references contacts, email_id uuid references emails,
  received_at timestamptz not null, label text, review_note text, body text);
"""

UNSURE = "confidence 0.42 < 0.6"  # what the reply classifier writes when it is not sure of the label

# name: (outreach email status or None = not emailed, [(label, review_note, days ago, text)], our answer or None)
LEADS = {
    "Positive Priya": ("sent", [("interested", None, 1, "Yes, let's talk next week.")], None),
    "Answered Anna": ("sent", [("interested", None, 3, "Sounds good, send me times.")], "sent"),
    "Queued Quentin": ("sent", [("interested", None, 2, "Happy to chat.")], "approved"),
    "Review Rahul": ("sent", [("interested", UNSURE, 1, "Maybe, depends on timing.")], None),
    "Doubtful Dev": ("sent", [("not_interested", UNSURE, 1, "Not sure this is for us right now.")], None),
    "Question Quinn": ("sent", [("question", None, 1, "What does it cost?")], None),
    "NotInterested Nina": ("sent", [("not_interested", None, 1, "No thanks.")], None),
    "ChangedMind Carl": ("sent", [("interested", None, 5, "Interested!"), ("not_interested", None, 1, "Not now.")], None),
    "Pending Paul": ("sent", [(None, None, 0, "Tell me more.")], None),
    "OutOfOffice Olga": ("sent", [("ooo", None, 1, "I am out of office until Monday.")], None),
    "Silent Sam": ("sent", [], None),
    "Bounced Ben": ("bounced", [], None),
    "New Nora": (None, [], None),
}


def _pg_bin(name: str) -> str | None:
    found = shutil.which(name) or sorted(glob.glob(f"/usr/lib/postgresql/*/bin/{name}"))
    return found if isinstance(found, str) else (found[-1] if found else None)


async def _seed(dsn: str) -> None:
    conn = await asyncpg.connect(dsn)
    try:
        await conn.execute(SCHEMA)
        for name, (outreach, replies, answer) in LEADS.items():
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
            reply = None
            for label, note, days, text in replies:
                reply = await conn.fetchval(
                    "insert into replies (contact_id, email_id, received_at, label, review_note, body)"
                    " values ($1, $2, now() - make_interval(days => $3), $4, $5, $6) returning id",
                    contact, email, days, label, note, text)
            if answer:
                await conn.execute(
                    "insert into emails (contact_id, mailbox, subject, status, sent_at, reply_id)"
                    " values ($1, 'us@test.invalid', 'Re: Hello', $2, case when $2 = 'sent' then now() end, $3)",
                    contact, answer, reply)
    finally:
        await conn.close()


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    initdb, pg_ctl = _pg_bin("initdb"), _pg_bin("pg_ctl")
    if not (initdb and pg_ctl):
        pytest.skip("Postgres is not installed (sudo apt install postgresql); the real-SQL mail tests are skipped")
    root = tmp_path_factory.mktemp("pg")
    datadir, sock = root / "data", root / "sock"
    sock.mkdir()
    subprocess.run([initdb, "-D", str(datadir), "-U", "postgres", "-A", "trust", "--no-sync"],
                   check=True, capture_output=True)
    # Only a socket in the temporary folder: no port, so it can't clash with another Postgres on this machine.
    subprocess.run([pg_ctl, "-D", str(datadir), "-l", str(root / "log"), "-w", "start",
                    "-o", f"-k {sock} -c listen_addresses='' -F"], check=True, capture_output=True)
    try:
        dsn = f"postgresql://postgres@/postgres?host={sock}"
        asyncio.run(_seed(dsn))
        with pytest.MonkeyPatch.context() as mp:
            mp.setenv("DATABASE_URL", dsn)
            mp.setenv("SUPABASE_URL", "https://example.supabase.co")
            mp.setenv("SUPABASE_JWT_SECRET", SECRET)
            mp.setattr(data, "_pool", None)  # a new pool, on this database
            with TestClient(app) as c:  # one event loop for every request, so the pool can be reused
                yield c
    finally:
        subprocess.run([pg_ctl, "-D", str(datadir), "-m", "immediate", "stop"], capture_output=True)


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
    tabs = {lead["name"]: tab for tab in ("positive", "review", "questions") for lead in res[tab]}
    assert tabs == {
        "Positive Priya": "positive",
        "Answered Anna": "positive",
        "Queued Quentin": "positive",
        "Review Rahul": "review",
        "Doubtful Dev": "review",
        "Question Quinn": "questions",
        # Not on the page: NotInterested Nina, ChangedMind Carl (their last reply says no), Pending Paul (not
        # classified yet), OutOfOffice Olga (automatic reply), Silent Sam, Bounced Ben, New Nora.
    }
    assert res["pending"] == 1  # Pending Paul: "1 new reply is still being classified"
    assert res["repliedLeads"] == 9  # everyone marked Responded in the table


def test_follow_up_column(client):
    res = _get(client, "/leads/positive")
    follow_up = {lead["name"]: lead["followUp"] for lead in res["positive"]}
    assert follow_up == {"Positive Priya": "waiting", "Answered Anna": "replied", "Queued Quentin": "queued"}
    assert res["positive"][0]["name"] == "Positive Priya"  # still waiting for our answer: listed first


def test_unsure_replies_say_why(client):
    review = _get(client, "/leads/positive")["review"]
    assert {lead["name"]: lead["reviewReason"] for lead in review} == {
        "Review Rahul": "Low confidence (0.42)", "Doubtful Dev": "Low confidence (0.42)"}


def test_dashboard_counts(client):
    stats = _get(client, "/leads/stats")
    assert {k: stats[k] for k in ("total", "notSent", "awaiting", "responded", "bounced")} == {
        "total": 13,
        "notSent": 1,  # New Nora
        "awaiting": 2,  # Silent Sam, OutOfOffice Olga (an out-of-office reply is not a response)
        "responded": 9,  # the same 9 as "Leads Replied" on Positive Leads
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
    }


def test_lead_is_judged_on_its_last_reply(client):
    carl = next(lead for lead in _get(client, "/leads?limit=200")["items"] if lead["name"] == "ChangedMind Carl")
    detail = _get(client, f"/leads/{carl['id']}")
    assert detail["latestReply"]["text"] == "Not now."
