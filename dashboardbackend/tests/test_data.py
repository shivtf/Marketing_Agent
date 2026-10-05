import time

import jwt
import pytest
from fastapi.testclient import TestClient

from app import data
from app.main import app

SECRET = "test-secret-that-is-long-enough-for-hs256"  # noqa: S105
client = TestClient(app)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)


def _auth():
    claims = {"sub": "u1", "aud": "authenticated", "exp": int(time.time()) + 60}
    return {"Authorization": f"Bearer {jwt.encode(claims, SECRET, algorithm='HS256')}"}


LEADS = [
    {"id": "a", "number": 2, "source": "x", "status": "Awaiting", "email": "p@q.co", "title": "CEO"},
    {"id": "b", "number": 1, "source": "linkedin", "status": "Responded", "email": "r@s.co"},
]


def test_data_routes_require_login():
    assert client.get("/leads").status_code == 401
    assert client.get("/blogs").status_code == 401


def test_leads_filter_and_hide_details(monkeypatch):
    async def rows(*_):
        return [dict(r) for r in LEADS]

    monkeypatch.setattr(data, "_rows", rows)
    res = client.get("/leads?status=awaiting", headers=_auth())
    assert res.json() == [{"id": "a", "number": 2, "source": "x", "status": "Awaiting"}]


def test_lead_stats(monkeypatch):
    async def rows(*_):
        return LEADS

    monkeypatch.setattr(data, "_rows", rows)
    assert client.get("/leads/stats", headers=_auth()).json() == {
        "total": 2,
        "awaiting": 1,
        "responded": 1,
        "bySource": {"linkedin": 1, "x": 1, "other": 0},
    }


def test_positive_leads_preview(monkeypatch):
    long = "x" * 150

    async def rows(*_):
        return [{"id": "a", "body": f"Hi Alex,\n\n{long}\n\nThanks"}]

    monkeypatch.setattr(data, "_rows", rows)
    (item,) = client.get("/leads/positive", headers=_auth()).json()
    assert item["preview"] == "x" * 99 + "…" and "body" not in item
