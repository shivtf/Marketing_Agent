"""The backend as the limited dashboard_backend login (migrations/009_dashboard_backend_role.sql), against a REAL Postgres
made to look like Supabase (auth schema, anon / authenticated roles, the agent's tables). Every route the dashboard uses
must work as that login, and the login must not be able to do more. Nothing here touches Supabase or Google."""

import asyncio
import pathlib
import secrets
import time
import uuid

import asyncpg
import jwt
import pytest
from conftest import throwaway_postgres
from fastapi.testclient import TestClient

from app import data, reply_rules
from app.main import app

SECRET = secrets.token_hex(32)  # signs fake test tokens only
MIGRATIONS = pathlib.Path(__file__).parent.parent / "migrations"
USER, SESSION = str(uuid.uuid4()), str(uuid.uuid4())

# Supabase's own parts the backend relies on, and the agent's tables (only the columns the dashboard reads).
SUPABASE = """
create role anon nologin;
create role authenticated nologin;
create schema auth;
create table auth.users (id uuid primary key, email text, raw_app_meta_data jsonb, banned_until timestamptz);
create table auth.sessions (id uuid primary key, user_id uuid references auth.users on delete cascade);
create table companies (
  id uuid primary key default gen_random_uuid(), name text, domain text, source text, source_url text,
  project_summary text, industry text, lead_status text not null default 'SENT', lead_score int, opportunity text,
  contact_form_url text, status_note text, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now());
create table contacts (
  id uuid primary key default gen_random_uuid(), company_id uuid references companies, name text, email text,
  role text, collected_at timestamptz not null default now(), last_engaged_at timestamptz);
create table emails (
  id uuid primary key default gen_random_uuid(), contact_id uuid references contacts, mailbox text, subject text,
  body text, status text, sent_at timestamptz, message_id text, gmail_thread_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table content_posts (
  id uuid primary key default gen_random_uuid(), title text, status text, devto_url text, cms_url text,
  linkedin_url text, published_at timestamptz, body_md text, created_at timestamptz not null default now());
-- The agent's do-not-email list (agent migration 0002); the dashboard reaches it only through migration 012.
create table suppression_list (email_hash text primary key, reason text not null,
  created_at timestamptz not null default now());
create function email_hash(addr text) returns text language sql immutable as
  $$ select encode(sha256(convert_to(lower(trim(addr)), 'UTF8')), 'hex') $$;
-- The agent's one write the dashboard may call (Marketing-AI-Agent migration 0013): a stand-in that moves the lead on.
create function submit_manual_contact(p_company uuid, p_email text, p_name text, p_role text, p_by text)
returns text language plpgsql security definer as $$
begin
  update companies set lead_status = 'CONTACT_ADDED' where id = p_company and lead_status = 'NEEDS_CONTACT';
  return case when found then 'ok' else 'not_waiting' end;
end $$;
"""


async def _seed(dsn):
    conn = await asyncpg.connect(dsn)
    try:
        await conn.execute(SUPABASE)
        for name in ("001_dashboard_presence", "006_gmail_connection", "007_inbox_replies", "008_inbox_indexes",
                     "009_dashboard_backend_role", "010_blog_approval", "011_blog_posts",
                     "012_unsubscribe_suppression", "013_reply_scores"):
            sql = (MIGRATIONS / f"{name}.sql").read_text()
            await conn.execute(sql)
            await conn.execute(sql)  # each is safe to run again
        await conn.execute("alter role dashboard_backend with login password 'test'")
        await conn.execute("insert into auth.users (id, email, raw_app_meta_data) values ($1, 'ana@team.test', "
                           "'{\"role\": \"admin\"}')", USER)
        await conn.execute("insert into auth.sessions (id, user_id) values ($1, $2)", SESSION, USER)
        await conn.execute("""
            insert into companies (name, domain, lead_status, lead_score) values
              ('Strong', 'strong.test', 'NEEDS_CONTACT', 90), ('Unscored', 'unscored.test', 'NEEDS_CONTACT', null),
              ('Weak', 'weak.test', 'NEEDS_CONTACT', 10);
            with co as (insert into companies (name, domain, source) values ('Acme', 'acme.test', 'leadgen:search')
                        returning id),
                 ct as (insert into contacts (company_id, name, email) select id, 'Priya', 'priya@acme.test' from co
                        returning id),
                 em as (insert into emails (contact_id, mailbox, subject, body, status, sent_at, message_id)
                        select id, 'us@us.test', 'Hello', 'Interested in a call?', 'sent', now(), '<m1@us.test>' from ct
                        returning id, contact_id)
            insert into inbox_replies (gmail_message_id, email_id, contact_id, match_method, from_email, body, received_at)
            select 'g1', id, contact_id, 'header', 'priya@acme.test', 'Yes, let''s talk.', now() from em;
            insert into content_posts (title, status) values ('A post', 'published');""")
    finally:
        await conn.close()


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    with throwaway_postgres(tmp_path_factory.mktemp("pg")) as dsn:
        asyncio.run(_seed(dsn))
        limited = dsn.replace("postgres@", "dashboard_backend:test@")
        with pytest.MonkeyPatch.context() as mp:
            mp.setenv("DATABASE_URL", limited)
            mp.setenv("SUPABASE_URL", "https://example.supabase.co")
            mp.setenv("SUPABASE_JWT_SECRET", SECRET)
            mp.setattr(data, "_pool", None)  # a new pool, as the limited login
            with TestClient(app) as c:
                yield {"client": c, "dsn": dsn, "limited": limited}


def _auth():
    claims = {"sub": USER, "session_id": SESSION, "email": "ana@team.test", "aud": "authenticated",
              "exp": int(time.time()) + 60, "app_metadata": {"role": "admin"}}
    return {"Authorization": f"Bearer {jwt.encode(claims, SECRET, algorithm='HS256')}"}


def _as(dsn, sql, *args):
    async def go():
        conn = await asyncpg.connect(dsn)
        try:
            return await conn.fetch(sql, *args)
        finally:
            await conn.close()

    return asyncio.run(go())


@pytest.mark.parametrize("path", ["/auth/me", "/leads", "/leads/stats", "/leads/positive", "/needs-contact",
                                  "/emails/sent", "/blogs"])
def test_every_page_works_as_the_limited_login(env, path):
    res = env["client"].get(path, headers=_auth())
    assert res.status_code == 200, res.text


def test_the_sign_in_check_runs_through_the_narrow_functions(env):
    assert env["client"].get("/auth/me", headers=_auth()).json()["role"] == "admin"
    assert _as(env["dsn"], "select session_id from dashboard_presence")[0]["session_id"] == uuid.UUID(SESSION)
    assert env["client"].post("/auth/signout", headers=_auth()).status_code == 200
    assert _as(env["dsn"], "select count(*) as n from dashboard_presence")[0]["n"] == 0


def test_a_reply_its_label_and_the_sent_email(env):
    c = env["client"]
    (row,) = c.get("/leads/positive", headers=_auth()).json()["positive"]
    assert row["name"] == "Priya" and row["preview"] == "Yes, let's talk."
    # The limited login may save the score it worked out (a refusal would only be logged, so it is checked here).
    assert [r["scored_with"] for r in _as(env["dsn"], "select scored_with from inbox_replies")] == [
        reply_rules.RULES_VERSION]
    assert c.post("/inbox/label", headers=_auth(), json={"replyId": row["replyId"], "label": "interested"}).json() == {
        "ok": True}
    assert c.get(f"/leads/by-reply/{row['id']}", headers=_auth()).json()["labelledBy"]["by"] == "ana@team.test"
    (sent,) = c.get("/emails/sent", headers=_auth()).json()["items"]
    assert sent["replyId"] == row["replyId"] and sent["deliveryStatus"] == "Sent"


def test_an_unsubscribe_label_reaches_the_do_not_email_list(env):
    # As the limited login: only through migration 012's functions (it can't touch suppression_list itself).
    c = env["client"]
    reply = str(_as(env["dsn"], "select id from inbox_replies where gmail_message_id = 'g1'")[0]["id"])
    count = "select count(*) as n from suppression_list where email_hash = email_hash('priya@acme.test')"
    assert c.post("/inbox/label", headers=_auth(), json={"replyId": reply, "label": "unsubscribe"}).status_code == 200
    assert _as(env["dsn"], count)[0]["n"] == 1
    assert c.post("/inbox/label", headers=_auth(), json={"replyId": reply, "label": "interested"}).status_code == 200
    assert _as(env["dsn"], count)[0]["n"] == 0


def test_needs_contact_strongest_first_unscored_last(env):
    items = env["client"].get("/needs-contact", headers=_auth()).json()["items"]
    assert [i["company"] for i in items] == ["Strong", "Weak", "Unscored"]


def test_adding_a_contact_goes_through_the_agents_function(env):
    c = env["client"]
    (weak,) = [i for i in c.get("/needs-contact", headers=_auth()).json()["items"] if i["company"] == "Weak"]
    res = c.post(f"/needs-contact/{weak['id']}/contact", headers=_auth(), json={"email": "jo@weak.test"})
    assert res.json() == {"ok": True}
    again = c.post(f"/needs-contact/{weak['id']}/contact", headers=_auth(), json={"email": "jo@weak.test"})
    assert again.status_code == 422  # no longer waiting: never 409, which would sign the user out


@pytest.mark.parametrize("sql", [
    "select * from auth.users",
    "select * from auth.sessions",
    "update companies set name = 'x'",
    "insert into contacts (email) values ('x@x.test')",
    "update emails set status = 'sent'",
    "delete from content_posts",
    "update gmail_connection set email = 'x'",
    "insert into gmail_connection (email, refresh_token) values ('x', 'y')",
    "select * from suppression_list",
    "insert into suppression_list (email_hash, reason) values ('x', 'manual')",
    "delete from suppression_list",
    "select * from dashboard_suppressions",
])
def test_the_limited_login_can_do_nothing_more(env, sql):
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        _as(env["limited"], sql)
