import secrets
import time

import jwt
import pytest
from fastapi.testclient import TestClient

from app.main import app

SECRET = secrets.token_hex(32)  # random each run: signs fake test tokens only, never a real key
client = TestClient(app)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)


def _token(**over):
    claims = {
        "sub": "u1",
        "email": "a@b.co",
        "role": "authenticated",
        "aud": "authenticated",
        "exp": int(time.time()) + 60,
        **over,
    }
    return jwt.encode(claims, SECRET, algorithm="HS256")


def _get(token=None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return client.get("/auth/me", headers=headers)


def test_health_is_public():
    assert client.get("/health").json() == {"ok": True}


def test_valid_token():
    r = _get(_token())
    assert r.status_code == 200
    assert r.json() == {"id": "u1", "email": "a@b.co", "role": "authenticated"}


def test_missing_token():
    assert _get().status_code == 401


def test_expired_token():
    assert _get(_token(exp=int(time.time()) - 10)).status_code == 401


def test_wrong_audience():
    assert _get(_token(aud="other")).status_code == 401


def test_bad_signature():
    bad = jwt.encode(
        {"sub": "u1", "aud": "authenticated", "exp": int(time.time()) + 60},
        "x" * 40,
        algorithm="HS256",
    )
    assert _get(bad).status_code == 401


def test_removed_user_is_rejected():
    assert _get(_token(app_metadata={"role": "employee", "removed": True})).status_code == 401


SESSION = "7d4c1a52-3f0e-4b8a-9c6d-2e1f0a9b8c7d"


@pytest.fixture
def presence(monkeypatch):
    """Fake database for the account / one-sign-in check: `alive` = the token's Supabase session exists,
    `removed` = the account is removed or banned in auth.users, `holder` = the session currently using the
    account (None = free), `fail` = the database can't be reached."""
    from app import data

    state = {"alive": True, "removed": False, "holder": None, "fail": False, "released": []}

    class Pool:
        async def fetchrow(self, sql, *_args):
            assert "from auth.users u" in sql
            return {"session_alive": state["alive"], "removed": state["removed"]}

        async def fetchval(self, sql, *args):
            user_id, session_id = args
            if state["holder"] in (None, session_id):
                state["holder"] = session_id
                return session_id
            return None

        async def execute(self, sql, *args):
            if "create table" in sql:
                return
            user_id, session_id = args
            state["released"].append(session_id)
            if state["holder"] == session_id:
                state["holder"] = None

    async def pg():
        if state["fail"]:
            raise RuntimeError("no database")
        return Pool()

    monkeypatch.setattr(data, "_pg", pg)
    return state


def test_first_session_takes_the_account(presence):
    assert _get(_token(session_id=SESSION)).status_code == 200
    assert presence["holder"] == SESSION


def test_second_session_is_refused_while_account_in_use(presence):
    presence["holder"] = "11111111-1111-4111-8111-111111111111"
    res = _get(_token(session_id=SESSION))
    assert res.status_code == 409 and res.json()["detail"] == "This account is already signed in on another device."


def test_token_from_ended_session_is_rejected(presence):
    presence["alive"] = False
    res = _get(_token(session_id=SESSION))
    assert res.status_code == 401 and res.json()["detail"] == "Session ended"


def test_account_removed_after_the_token_was_issued_is_rejected(presence):
    presence["removed"] = True  # the token itself has no "removed" flag: it was issued before the removal
    res = _get(_token(session_id=SESSION))
    assert res.status_code == 401 and res.json()["detail"] == "Account removed"
    assert presence["holder"] is None  # a removed account never takes the sign-in


def test_signout_frees_the_account(presence):
    headers = {"Authorization": f"Bearer {_token(session_id=SESSION)}"}
    assert client.post("/auth/signout", headers=headers).json() == {"ok": True}
    assert presence["released"] == [SESSION] and presence["holder"] is None


def test_session_check_failure_allows_token(presence):
    presence["fail"] = True
    assert _get(_token(session_id=SESSION)).status_code == 200
