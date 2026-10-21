"""Posting approved blogs (app/blog_posts.py) against a REAL Postgres, as the limited dashboard_backend login, with
migrations 010 and 011 applied. Dev.to is replaced by a stand-in: nothing leaves the machine."""

import asyncio
import json
import pathlib
from datetime import date

import asyncpg
import pytest
from conftest import throwaway_postgres
from fastapi.testclient import TestClient
from test_role_sql import SECRET, _as, _auth, _seed

from app import blog_posts, data
from app.main import app

MIGRATIONS = pathlib.Path(__file__).parent.parent / "migrations"
DAY = date(2026, 10, 21)


async def _seed_blogs(dsn):
    conn = await asyncpg.connect(dsn)
    try:
        for name in ("010_blog_approval", "011_blog_posts"):
            sql = (MIGRATIONS / f"{name}.sql").read_text()
            await conn.execute(sql)
            await conn.execute(sql)  # each is safe to run again
    finally:
        await conn.close()


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    with throwaway_postgres(tmp_path_factory.mktemp("pg")) as dsn:
        asyncio.run(_seed(dsn))  # runs 010 and 011 too (test_role_sql)
        asyncio.run(_seed_blogs(dsn))  # and again: each is safe to run again
        limited = dsn.replace("postgres@", "dashboard_backend:test@")
        with pytest.MonkeyPatch.context() as mp:
            mp.setenv("DATABASE_URL", limited)
            mp.setenv("SUPABASE_URL", "https://example.supabase.co")
            mp.setenv("SUPABASE_JWT_SECRET", SECRET)
            mp.setenv("DEVTO_API_KEY", "test-key")
            mp.setattr(data, "_pool", None)  # a new pool, as the limited login
            mp.setattr(blog_posts, "today", lambda: DAY)
            with TestClient(app) as c:
                yield {"client": c, "dsn": dsn}


@pytest.fixture
def devto(monkeypatch):
    """Stand-in for Dev.to: records each post; a title in `fail` raises that PostError."""
    state = {"calls": [], "fail": {}}

    async def post(title, body, tags, publish):
        state["calls"].append({"title": title, "body": body, "tags": tags, "publish": publish})
        if title in state["fail"]:
            raise blog_posts.PostError(state["fail"][title])
        return f"https://dev.to/us/{len(state['calls'])}", str(len(state["calls"]))

    monkeypatch.setattr(blog_posts, "post_to_devto", post)
    monkeypatch.setenv("BLOG_POSTING", "live")
    return state


def _approve(env, file, blog_id, day=DAY, status="approved", **blog):
    raw = {"id": blog_id, "topic": f"Topic {blog_id}", "content": f"# Topic {blog_id}\n\nBody of {blog_id}.",
           "keywords": ["CI/CD", "Jenkins"], **blog}
    _as(env["dsn"], """insert into blog_approval (file_name, blog_id, status, blog, blog_hash, publish_date, reason,
                                                  decided_by)
                       values ($1, $2, $3, $4::jsonb, $5, $6, $7, 'ana@team.test')""",
        file, blog_id, status, json.dumps(raw), f"h-{blog_id}", day, "no" if status == "rejected" else None)


def _post(env, path="/blog-posts/post-today", **kw):
    return env["client"].post(path, headers=_auth(), **kw)


def _row(env, file, blog_id):
    rows = _as(env["dsn"], "select * from blog_posts where file_name = $1 and blog_id = $2", file, blog_id)
    return rows[0] if rows else None


def test_nothing_is_posted_while_posting_is_off(env, monkeypatch):
    monkeypatch.delenv("BLOG_POSTING", raising=False)
    res = _post(env)
    assert res.status_code == 503 and "BLOG_POSTING" in res.json()["detail"]


def test_only_todays_approved_blogs_are_posted_and_only_once(env, devto):
    _approve(env, "a.json", "A1")
    _approve(env, "a.json", "A2", day=date(2026, 10, 22))  # tomorrow
    _approve(env, "a.json", "A3", status="rejected")
    res = _post(env).json()
    assert [p["blogId"] for p in res["posted"]] == ["A1"] and res["failed"] == [] and res["mode"] == "live"
    (call,) = devto["calls"]
    assert call == {"title": "Topic A1", "body": "Body of A1.", "tags": ["cicd", "jenkins"], "publish": True}
    row = _row(env, "a.json", "A1")
    assert row["status"] == "posted" and row["url"] == "https://dev.to/us/1" and row["started_by"] == "ana@team.test"
    assert _post(env).json()["skipped"] >= 1 and len(devto["calls"]) == 1  # a second click posts nothing again
    items = env["client"].get("/blogs", headers=_auth()).json()["items"]
    assert any(i["title"] == "Topic A1" and i["status"] == "Posted" and i["site"] == "Dev.to" for i in items)


def test_a_failed_blog_waits_for_post_again(env, devto):
    _approve(env, "b.json", "B1")
    devto["fail"]["Topic B1"] = "Dev.to had an error (502)."
    res = _post(env).json()
    assert res["failed"] == [{"fileName": "b.json", "blogId": "B1", "error": "Dev.to had an error (502)."}]
    assert _row(env, "b.json", "B1")["status"] == "failed"
    _post(env)
    assert len(devto["calls"]) == 1  # not retried on its own
    del devto["fail"]["Topic B1"]
    res = _post(env, "/blog-posts/post-again", json={"fileName": "b.json", "blogId": "B1"}).json()
    assert [p["blogId"] for p in res["posted"]] == ["B1"]
    row = _row(env, "b.json", "B1")
    assert row["status"] == "posted" and row["attempts"] == 2 and row["error"] is None
    again = _post(env, "/blog-posts/post-again", json={"fileName": "b.json", "blogId": "B1"})
    assert again.status_code == 422  # posted: never twice


def test_a_blog_taken_back_is_not_posted(env, devto):
    _approve(env, "c.json", "C1")
    _as(env["dsn"], "delete from blog_approval where file_name = 'c.json'")  # an admin moved it back to waiting
    assert _post(env).json()["posted"] == [] and _row(env, "c.json", "C1") is None
    assert devto["calls"] == []


def test_the_claim_checks_the_approval_again(env):
    """Taken back, or the file replaced, between listing today's blogs and posting one: the claim refuses it."""
    _approve(env, "e.json", "E1")

    limited = env["dsn"].replace("postgres@", "dashboard_backend:test@")

    def claim(blog_hash):
        return _as(limited, blog_posts._CLAIM, "e.json", "E1", False, "T", "B", blog_hash, "ana@team.test", DAY, False)

    assert claim("another-version") == []
    _as(env["dsn"], "update blog_approval set publish_date = '2026-10-22' where file_name = 'e.json'")
    assert claim("h-E1") == []
    assert _row(env, "e.json", "E1") is None


def test_a_draft_is_posted_for_real_once_posting_is_live(env, devto, monkeypatch):
    _approve(env, "d.json", "D1")
    monkeypatch.setenv("BLOG_POSTING", "draft")
    res = _post(env).json()
    assert [p["draft"] for p in res["posted"] if p["blogId"] == "D1"] == [True]
    assert devto["calls"][-1]["publish"] is False
    _post(env)
    assert len(devto["calls"]) == 1  # still draft mode: not posted again
    monkeypatch.setenv("BLOG_POSTING", "live")
    res = _post(env).json()
    assert [p["blogId"] for p in res["posted"]] == ["D1"] and devto["calls"][-1]["publish"] is True
    assert _row(env, "d.json", "D1")["draft"] is False


def test_the_login_reads_approvals_but_cannot_write_them(env):
    limited = env["dsn"].replace("postgres@", "dashboard_backend:test@")
    assert _as(limited, "select count(*) as n from blog_approval")[0]["n"] >= 1
    with pytest.raises(Exception, match="permission denied"):
        _as(limited, "update blog_approval set status = 'approved'")
    with pytest.raises(Exception, match="permission denied"):
        _as(limited, "delete from blog_posts")
