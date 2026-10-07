import json
import time

import httpx
import jwt
import pytest
from fastapi.testclient import TestClient

from app import agent
from app.main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    monkeypatch.setenv("AGENT_API_URL", "https://pipeline.test/")
    monkeypatch.setenv("AGENT_API_TOKEN", "tok")


def _auth():
    claims = {"sub": "u1", "email": "a@b.co", "aud": "authenticated", "exp": int(time.time()) + 60}
    return {"Authorization": f"Bearer {jwt.encode(claims, SECRET, algorithm='HS256')}"}


@pytest.fixture
def pipeline(monkeypatch):
    """Fake pipeline API: records each request and answers with `reply` (status, body)."""
    calls: list[httpx.Request] = []
    reply = {"status": 200, "body": {"desired_state": "running", "state": "stopped", "in_sync": False}}

    def handler(request):
        calls.append(request)
        return httpx.Response(reply["status"], json=reply["body"])

    monkeypatch.setattr(agent, "_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    return calls, reply


def test_agent_routes_require_login():
    assert client.get("/agent").status_code == 401
    assert client.post("/agent/stop").status_code == 401


def test_start_forwards_token_and_user(pipeline):
    calls, _ = pipeline
    res = client.post("/agent/start", headers=_auth())
    assert res.json() == {"desiredState": "running", "state": "stopped", "inSync": False}
    req = calls[0]
    assert req.method == "POST" and str(req.url) == "https://pipeline.test/api/v1/pipeline/start"
    assert req.headers["authorization"] == "Bearer tok"
    assert json.loads(req.content) == {"requested_by": "a@b.co"}


def test_status_and_stop(pipeline):
    calls, _ = pipeline
    client.get("/agent", headers=_auth())
    client.post("/agent/stop", headers=_auth())
    assert [(r.method, r.url.path) for r in calls] == [
        ("GET", "/api/v1/pipeline/status"),
        ("POST", "/api/v1/pipeline/stop"),
    ]


def test_bad_token_is_explained(pipeline):
    _, reply = pipeline
    reply.update(status=401, body={"detail": "bad token"})
    res = client.get("/agent", headers=_auth())
    assert res.status_code == 502 and "AGENT_API_TOKEN" in res.json()["detail"]


def test_missing_token_is_503(monkeypatch):
    monkeypatch.delenv("AGENT_API_TOKEN")
    monkeypatch.delenv("PIPELINE_API_TOKEN", raising=False)
    assert client.get("/agent", headers=_auth()).status_code == 503
