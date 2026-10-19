import secrets
import time

import asyncpg
import jwt
import pytest
from fastapi.testclient import TestClient

from app import accounts, data
from app.main import app

_FUNCTIONS = ("dashboard_account_state(", "dashboard_claim(", "dashboard_user_role(", "dashboard_end_sessions(")
SECRET = secrets.token_hex(32)  # random each run: signs fake test tokens only, never a real key
client = TestClient(app)
ADMIN = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"
SESSION = "33333333-3333-4333-8333-333333333333"


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)


def _auth(sub=ADMIN, **extra):
    claims = {"sub": sub, "aud": "authenticated", "exp": int(time.time()) + 60,
              "app_metadata": {"role": "employee"}, **extra}
    return {"Authorization": f"Bearer {jwt.encode(claims, SECRET, algorithm='HS256')}"}


@pytest.fixture
def db(monkeypatch):
    """Fake database: `role` = the caller's role in auth.users; records every delete; `refuse` = permission denied."""
    state = {"role": "admin", "deletes": [], "refuse": False}

    class Pool:
        async def fetchval(self, sql, *_):
            if any(f in sql for f in _FUNCTIONS):  # a database without migrations/009
                raise asyncpg.UndefinedFunctionError(f"function does not exist: {sql[:40]}")
            assert "raw_app_meta_data->>'role'" in sql
            return state["role"]

        async def execute(self, sql, *args):
            if state["refuse"]:
                raise asyncpg.InsufficientPrivilegeError("permission denied for table sessions")
            state["deletes"].append((sql, args))
            return "DELETE 2" if "auth.sessions" in sql else "DELETE 1"

    async def pg():
        return Pool()

    monkeypatch.setattr(data, "_pg", pg)
    monkeypatch.setattr(accounts, "_pg", pg)
    return state


def test_admin_ends_every_session_of_a_user(db):
    res = client.post(f"/admin/users/{OTHER}/end-sessions", headers=_auth())
    assert res.status_code == 200 and res.json() == {"ended": 2}
    (sessions_sql, args), (presence_sql, _) = db["deletes"]
    assert sessions_sql == "delete from auth.sessions where user_id = $1::uuid" and args == (OTHER,)
    assert "dashboard_presence" in presence_sql


def test_employee_cannot_end_someone_elses_sessions(db):
    db["role"] = "employee"
    assert client.post(f"/admin/users/{OTHER}/end-sessions", headers=_auth()).status_code == 403
    assert db["deletes"] == []


def test_admin_cannot_end_own_sessions_there(db):
    assert client.post(f"/admin/users/{ADMIN}/end-sessions", headers=_auth()).status_code == 400
    assert db["deletes"] == []


def test_bad_user_id_is_404(db):
    assert client.post("/admin/users/not-a-uuid/end-sessions", headers=_auth()).status_code == 404


def test_refused_by_the_database_is_explained(db):
    db["refuse"] = True
    res = client.post(f"/admin/users/{OTHER}/end-sessions", headers=_auth())
    assert res.status_code == 503 and "refused" in res.json()["detail"]


def test_end_other_sessions_keeps_this_one(db, monkeypatch):
    from app import auth

    async def ok(_claims, _method="GET"):  # skip the one-sign-in check: covered in test_auth
        return None

    monkeypatch.setattr(auth, "_check_session", ok)
    res = client.post("/auth/end-other-sessions", headers=_auth(OTHER, session_id=SESSION))
    assert res.json() == {"ended": 2}
    ((sql, args),) = db["deletes"]
    assert "id <> $2::uuid" in sql and args == (OTHER, SESSION)


def test_routes_need_login():
    assert client.post(f"/admin/users/{OTHER}/end-sessions").status_code == 401
    assert client.post("/auth/end-other-sessions").status_code == 401
