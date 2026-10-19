import secrets
import time

import asyncpg
import jwt
import pytest
from fastapi.testclient import TestClient

from app import auth
from app.main import app

_FUNCTIONS = ("dashboard_account_state(", "dashboard_claim(", "dashboard_user_role(", "dashboard_end_sessions(")
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
        "app_metadata": {"role": "employee"},
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


@pytest.mark.parametrize("app_metadata", [None, {}, {"role": None}, {"role": "hacker"}, {"role": "authenticated"}])
def test_account_without_a_dashboard_role_is_refused(app_metadata):
    # e.g. a Supabase account that signed itself up: a valid token, but no role from an admin
    res = _get(_token(app_metadata=app_metadata))
    assert res.status_code == 403 and res.json()["detail"] == "This account has no access to the dashboard."


@pytest.mark.parametrize("role", ["admin", "employee"])
def test_dashboard_roles_are_allowed(role):
    assert _get(_token(app_metadata={"role": role})).status_code == 200


def test_data_routes_refuse_an_account_without_a_role():
    headers = {"Authorization": f"Bearer {_token(app_metadata={})}"}
    assert client.get("/leads", headers=headers).status_code == 403
    assert client.get("/emails/sent", headers=headers).status_code == 403


def test_account_without_a_role_never_takes_the_sign_in(presence):
    assert _get(_token(session_id=SESSION, app_metadata={})).status_code == 403
    assert presence["holder"] is None


def test_removed_user_is_rejected():
    assert _get(_token(app_metadata={"role": "employee", "removed": True})).status_code == 401


SESSION = "7d4c1a52-3f0e-4b8a-9c6d-2e1f0a9b8c7d"


@pytest.fixture
def presence(monkeypatch):
    """Fake database for the account / one-sign-in check: `alive` = the token's Supabase session exists,
    `removed` = the account is removed or banned in auth.users, `holder` = the session currently using the
    account (None = free), `fail` = the database can't be reached."""
    from app import data

    state = {"alive": True, "removed": False, "holder": None, "fail": False, "no_table": False, "released": []}

    class Pool:
        """A database without migrations/009: the narrow functions do not exist, the queries go to the tables."""

        def _no_function(self, sql):
            if state.get("functions") is None and any(f in sql for f in _FUNCTIONS):
                raise asyncpg.UndefinedFunctionError(f"function does not exist: {sql[:40]}")

        async def fetchrow(self, sql, *_args):
            self._no_function(sql)
            state.setdefault("sql", []).append(sql)
            assert "from auth.users u" in sql or "dashboard_account_state(" in sql
            return {"session_alive": state["alive"], "removed": state["removed"]}

        async def fetchval(self, sql, *args):
            if state["no_table"]:
                raise asyncpg.UndefinedTableError('relation "dashboard_presence" does not exist')
            self._no_function(sql)
            state.setdefault("sql", []).append(sql)
            user_id, session_id = args
            if state["holder"] in (None, session_id):
                state["holder"] = session_id
                return session_id
            return None

        async def execute(self, sql, *args):
            assert "create table" not in sql  # tables come from migrations only, never from the running backend
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


def test_session_check_failure_refuses_the_request(presence):
    # Fails closed: during an outage a removed account or a second sign-in must not slip through. 503, not 401/409,
    # so the dashboard keeps the user signed in and offers Retry.
    presence["fail"] = True
    res = _get(_token(session_id=SESSION))
    assert res.status_code == 503 and res.json()["detail"] == "Couldn't check your sign-in right now. Try again in a moment."


def test_missing_presence_table_is_named(presence):
    presence["no_table"] = True
    res = _get(_token(session_id=SESSION))
    assert res.status_code == 503 and "001_dashboard_presence.sql" in res.json()["detail"]


def test_a_passed_check_is_reused_briefly(presence, monkeypatch):
    calls = []
    real = auth._account

    async def counting(*args):
        calls.append(args)
        return await real(*args)

    monkeypatch.setattr(auth, "_account", counting)
    token = _token(session_id=SESSION)
    assert _get(token).status_code == 200 and _get(token).status_code == 200
    assert len(calls) == 1  # the second request within CHECKED_FOR skipped the database
    # After sign-out the session is checked again at once.
    client.post("/auth/signout", headers={"Authorization": f"Bearer {token}"})
    _get(token)
    assert len(calls) >= 2


def test_a_failed_check_is_never_remembered(presence):
    presence["fail"] = True
    token = _token(session_id=SESSION)
    assert _get(token).status_code == 503
    presence["fail"] = False
    presence["removed"] = True
    assert _get(token).status_code == 401  # checked again, not let through from memory



def test_a_change_is_refused_when_the_sign_in_check_cannot_run(presence):
    presence["fail"] = True
    headers = {"Authorization": f"Bearer {_token(session_id=SESSION)}"}
    assert client.post("/auth/signout", headers=headers).status_code == 503


def test_the_narrow_functions_are_used_when_migration_009_is_applied(presence):
    presence["functions"] = True
    assert _get(_token(session_id=SESSION)).status_code == 200
    assert any("dashboard_account_state(" in s for s in presence["sql"])
    assert any("dashboard_claim(" in s for s in presence["sql"])
    assert not any("from auth.users u" in s for s in presence["sql"])
