import secrets
import time

import asyncpg
import jwt
import pytest
from fastapi.testclient import TestClient

from app import data, needs_contact
from app.main import app

SECRET = secrets.token_hex(32)  # random each run: signs fake test tokens only, never a real key
client = TestClient(app)
COMPANY = "44444444-4444-4444-8444-444444444444"


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)


def _auth():
    claims = {"sub": "u1", "email": "me@acme.co", "aud": "authenticated", "exp": int(time.time()) + 60,
              "app_metadata": {"role": "employee"}}
    return {"Authorization": f"Bearer {jwt.encode(claims, SECRET, algorithm='HS256')}"}


@pytest.fixture
def pool(monkeypatch):
    """Fake pool: submit_manual_contact() answers `answer` (or raises `fail`); every call is recorded."""
    state = {"answer": "ok", "fail": None, "calls": []}

    class Pool:
        async def fetchval(self, sql, *args):
            state["calls"].append((sql, args))
            if state["fail"]:
                raise state["fail"]
            return state["answer"]

    async def pg():
        return Pool()

    monkeypatch.setattr(needs_contact, "_pg", pg)
    return state


def test_routes_require_login():
    assert client.get("/needs-contact").status_code == 401
    assert client.post(f"/needs-contact/{COMPANY}/contact", json={"email": "a@b.co"}).status_code == 401


def test_list_is_a_page_of_waiting_companies_strongest_first(monkeypatch):
    calls = []

    async def rows(sql, *args):
        calls.append((sql, args))
        return [{"id": "a", "company": "Acme", "website": "https://acme.com", "score": 72, "formUrl": None}]  # as _rows returns it (camelCase)

    async def value(sql, *args):
        return 1

    monkeypatch.setattr(data, "_rows", rows)
    monkeypatch.setattr(data, "_value", value)
    res = client.get("/needs-contact?limit=20", headers=_auth()).json()
    assert res["total"] == 1 and res["limit"] == 20
    assert res["items"][0]["company"] == "Acme" and res["items"][0]["formUrl"] is None
    sql, args = calls[0]
    assert "lead_status = 'NEEDS_CONTACT'" in sql and "order by score desc" in sql and args == (20, 0)


def test_adding_an_email_calls_the_sql_function_with_who_did_it(pool):
    res = client.post(f"/needs-contact/{COMPANY}/contact", headers=_auth(),
                      json={"email": " Sales@Acme.com ", "name": "Ana", "role": "CTO"})
    assert res.status_code == 200 and res.json() == {"ok": True}
    sql, args = pool["calls"][0]
    assert "submit_manual_contact" in sql
    assert args == (COMPANY, " Sales@Acme.com ", "Ana", "CTO", "me@acme.co")  # the database trims, lowercases, checks


@pytest.mark.parametrize(("answer", "status"), [("invalid", 422), ("suppressed", 422), ("not_waiting", 422), ("unknown", 404)])
def test_refusals_never_use_409(pool, answer, status):
    pool["answer"] = answer
    res = client.post(f"/needs-contact/{COMPANY}/contact", headers=_auth(), json={"email": "a@b.co"})
    assert res.status_code == status and isinstance(res.json()["detail"], str)  # 409 would sign the user out


def test_bad_company_id_and_oversized_fields(pool):
    assert client.post("/needs-contact/not-a-uuid/contact", headers=_auth(), json={"email": "a@b.co"}).status_code == 404
    assert client.post(f"/needs-contact/{COMPANY}/contact", headers=_auth(), json={"email": "a" * 300}).status_code == 422
    assert client.post(f"/needs-contact/{COMPANY}/contact", headers=_auth(), json={}).status_code == 422
    assert pool["calls"] == []


def test_database_failure_is_a_503_not_a_crash(pool):
    pool["fail"] = asyncpg.UndefinedFunctionError("function submit_manual_contact does not exist")
    res = client.post(f"/needs-contact/{COMPANY}/contact", headers=_auth(), json={"email": "a@b.co"})
    assert res.status_code == 503
