import secrets
import time

import jwt
import pytest
from fastapi.testclient import TestClient

from app import data
from app.main import app

SECRET = secrets.token_hex(32)  # random each run: signs fake test tokens only, never a real key
client = TestClient(app)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)


def _auth():
    claims = {"sub": "u1", "aud": "authenticated", "exp": int(time.time()) + 60}
    return {"Authorization": f"Bearer {jwt.encode(claims, SECRET, algorithm='HS256')}"}


LEADS = [
    {"id": "a", "number": 2, "source": "search", "status": "Sent", "email": "p@q.co", "title": "CEO",
     "company": "Acme", "about": "Builds Android BSPs"},
    {"id": "b", "number": 1, "source": "hn_hiring", "status": "Responded", "email": "r@s.co"},
    {"id": "c", "number": 3, "source": "hn_hiring", "status": "Not Sent", "email": "t@u.co"},
]


def test_data_routes_require_login():
    assert client.get("/leads").status_code == 401
    assert client.get("/blogs").status_code == 401


@pytest.fixture
def db(monkeypatch):
    """Fake _rows/_value: records each (sql, args) and answers with `answer` (rows for _rows, a number for _value)."""
    calls: list[tuple[str, tuple]] = []
    answer = {"rows": [], "value": 0}

    async def rows(sql, *args):
        calls.append((sql, args))
        return [dict(r) for r in answer["rows"]]

    async def value(sql, *args):
        calls.append((sql, args))
        return answer["value"]

    monkeypatch.setattr(data, "_rows", rows)
    monkeypatch.setattr(data, "_value", value)
    return calls, answer


def test_leads_page_filters_in_sql_and_hides_details(db):
    calls, answer = db
    answer.update(rows=LEADS[:2], value=120)
    res = client.get("/leads?status=sent&source=search&page=3&limit=20", headers=_auth()).json()
    assert res["total"] == 120 and res["page"] == 3 and res["limit"] == 20
    assert res["items"][0] == {
        "id": "a", "number": 2, "source": "search", "status": "Sent", "company": "Acme", "email": "p@q.co"
    }
    count_sql, count_args = calls[0]
    page_sql, page_args = calls[1]
    assert "where status = $1 and source = $2" in count_sql and count_args == ("Sent", "search")
    assert "limit $3 offset $4" in page_sql and page_args == ("Sent", "search", 20, 40)


def test_leads_defaults_to_first_page_of_50(db):
    calls, _ = db
    res = client.get("/leads", headers=_auth()).json()
    assert res == {"items": [], "total": 0, "page": 1, "limit": 50}
    assert ") t where" not in calls[0][0] and calls[1][1] == (50, 0)


def test_page_limits_are_checked(db):
    assert client.get("/leads?page=0", headers=_auth()).status_code == 422
    assert client.get("/emails/sent?limit=500", headers=_auth()).status_code == 422


def test_blogs_page_counts_posted(db):
    _, answer = db
    answer.update(rows=[{"id": "p", "number": 1, "status": "Posted", "content": "long"}], value=7)
    res = client.get("/blogs", headers=_auth()).json()
    assert res["items"] == [{"id": "p", "number": 1, "status": "Posted"}] and res["posted"] == 7


def test_lead_stats(monkeypatch):
    async def rows(*_):
        return [
            {"source": "hn_hiring", "status": "Sent", "n": 1},
            {"source": "hn_hiring", "status": "Responded", "n": 1},
            {"source": "search", "status": "Not Sent", "n": 2},
            {"source": "search", "status": "Bounced", "n": 1},
        ]

    monkeypatch.setattr(data, "_rows", rows)
    assert client.get("/leads/stats", headers=_auth()).json() == {
        "total": 5,
        "notSent": 2,
        "awaiting": 1,
        "responded": 1,
        "bounced": 1,
        "bySource": {"search": 3, "hn_hiring": 2},
    }


def _reply(id_, label, body="Hi Alex,\n\nSounds good.\n\nThanks", note=None, at="2026-10-01", answered=None, queued=False):
    return {"id": id_, "label": label, "reviewNote": note, "body": body, "repliedAt": at,
            "answeredAt": answered, "answerQueued": queued}


@pytest.fixture
def positive_rows(monkeypatch):
    """Serve the given rows to /leads/positive, with 2 replies still waiting to be classified."""
    def use(rows):
        async def fake_rows(*_):
            return [dict(r) for r in rows]

        async def fake_value(*_):
            return 2

        monkeypatch.setattr(data, "_rows", fake_rows)
        monkeypatch.setattr(data, "_value", fake_value)
    return use


def test_positive_leads_groups(positive_rows):
    positive_rows([
        _reply("a", "interested"),
        _reply("b", "interested", note="confidence 0.42 < 0.6"),
        _reply("c", "question"),
        _reply("d", "interested", note="reply_body too long"),  # draft problem only: still positive
        _reply("e", "not_interested"),
        _reply("f", "unsubscribe"),
        _reply("g", "not_interested", note="confidence 0.50 < 0.6"),  # doubtful "no" -> review
    ])
    res = client.get("/leads/positive", headers=_auth()).json()
    assert sorted(r["id"] for r in res["positive"]) == ["a", "d"]
    assert [r["id"] for r in res["review"]] == ["b", "g"]  # equal wait: stable sort keeps input order
    assert {r["id"]: r["reviewReason"] for r in res["review"]}["b"] == "Low confidence (0.42)"
    assert [r["id"] for r in res["questions"]] == ["c"]
    assert res["repliedLeads"] == 7 and res["pending"] == 2
    assert all("body" not in r and "reviewNote" not in r and "answerQueued" not in r for r in res["positive"])


def test_positive_leads_follow_up_order(positive_rows):
    positive_rows([
        _reply("replied", "interested", at="2026-10-05", answered="2026-10-05T12:00:00"),
        _reply("waiting-new", "interested", at="2026-10-04"),
        _reply("queued", "interested", at="2026-10-03", queued=True),
        _reply("waiting-old", "interested", at="2026-10-01"),
    ])
    res = client.get("/leads/positive", headers=_auth()).json()["positive"]
    # waiting first (longest-waiting on top), then the rest newest first
    assert [r["id"] for r in res] == ["waiting-old", "waiting-new", "replied", "queued"]
    assert [r["followUp"] for r in res] == ["waiting", "waiting", "replied", "queued"]


def test_positive_leads_preview(positive_rows):
    positive_rows([_reply("a", "interested", body=f"Hi Alex,\n\n{'x' * 150}\n\nThanks")])
    (item,) = client.get("/leads/positive", headers=_auth()).json()["positive"]
    assert item["preview"] == "x" * 99 + "…"


def test_preview_drops_greeting_and_quoted_mail():
    body = (
        "Hi Alex,\n\nYes, a call on Thursday works.\nSend me two time slots.\n\n"
        "On Mon, 5 Oct 2026 at 10:00, Alex <alex@agency.example> wrote:\n> Would you like a call?"
    )
    assert data._preview(body) == "Yes, a call on Thursday works. Send me two time slots."
    assert data._preview("> only quoted text") == ""
    assert data._preview(None) == ""
