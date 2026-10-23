import asyncio
from datetime import date

import asyncpg
import httpx

from app import blog_posts


def test_a_late_blog_may_be_from_this_week_only():
    assert blog_posts.week_start(date(2026, 10, 21)) == date(2026, 10, 19)  # Wednesday -> its Monday
    assert blog_posts.week_start(date(2026, 10, 24)) == date(2026, 10, 19)  # Saturday
    assert blog_posts.week_start(date(2026, 10, 25)) == date(2026, 10, 25)  # Sunday: last week has ended


def test_tags_fit_devto():
    assert blog_posts.devto_tags(["CI/CD", "Jenkins", "ci-cd", "", "Docker", "K8s", "more"]) == [
        "cicd", "jenkins", "docker", "k8s"]
    assert blog_posts.devto_tags(None) == []


def test_the_heading_line_is_left_out_of_the_body():
    blog = {"id": "B1", "topic": "Jenkins tips", "content": "\n# Jenkins tips\n\nFirst line.\n## More", "keywords": []}
    assert blog_posts.article(blog) == ("Jenkins tips", "First line.\n## More", [])
    assert blog_posts.article({"id": "B2", "content": "No heading."}) == ("B2", "No heading.", [])


def test_posting_mode_defaults_to_off(monkeypatch):
    monkeypatch.delenv("BLOG_POSTING", raising=False)
    assert blog_posts.posting_mode() == "off"
    monkeypatch.setenv("BLOG_POSTING", " Live ")
    assert blog_posts.posting_mode() == "live"
    monkeypatch.setenv("BLOG_POSTING", "yes")
    assert blog_posts.posting_mode() == "off"


def test_the_headline_is_the_title_when_there_is_one():
    blog = {"id": "B1", "title": "The real title", "topic": "What it is about", "content": "Text."}
    assert blog_posts.article(blog)[0] == "The real title"
    assert blog_posts.article({**blog, "title": "  "})[0] == "What it is about"


def test_the_page_can_ask_for_the_mode(monkeypatch):
    from fastapi.testclient import TestClient

    from app.auth import current_user
    from app.main import app

    app.dependency_overrides[current_user] = lambda: {"sub": "u1"}
    try:
        monkeypatch.setenv("BLOG_POSTING", "draft")
        assert TestClient(app).get("/blog-posts/mode").json() == {"mode": "draft"}
    finally:
        app.dependency_overrides.clear()



def test_a_2xx_answer_that_is_not_json_counts_as_posted(monkeypatch):
    real = httpx.AsyncClient
    answer = httpx.MockTransport(lambda req: httpx.Response(201, text="<html>Created</html>"))
    monkeypatch.setattr(blog_posts.httpx, "AsyncClient", lambda **kw: real(transport=answer, **kw))
    monkeypatch.setenv("DEVTO_API_KEY", "k")
    assert asyncio.run(blog_posts.post_to_devto("T", "B", [], True)) == ("", "")


def test_a_post_the_database_cannot_record_is_reported_not_raised(monkeypatch):
    class Pool:  # claims the blog, then refuses every write
        async def fetchrow(self, *_):
            return {"id": 1, "attempts": 1}

        async def execute(self, *_):
            raise asyncpg.PostgresConnectionError("gone")

    async def post(*_, **__):
        return "https://dev.to/us/1", "1"

    async def no_wait(_):
        return None

    monkeypatch.setattr(blog_posts, "post_to_devto", post)
    monkeypatch.setattr(blog_posts.asyncio, "sleep", no_wait)
    row = {"file_name": "a.json", "blog_id": "A1", "blog": {"id": "A1", "content": "Text."}, "blog_hash": "h",
           "publish_date": None}
    out = asyncio.run(blog_posts._post_one(Pool(), row, "live", "ana", False))
    assert "couldn't record it" in out["error"] and "https://dev.to/us/1" in out["error"]
