import datetime as dt
import json
import secrets
import time
from pathlib import Path

import jwt
import pytest
from fastapi.testclient import TestClient

from app import blog_plan, data
from app.main import app

SECRET = secrets.token_hex(32)  # random each run: signs fake test tokens only, never a real key
client = TestClient(app)
SAMPLES = Path(__file__).resolve().parent.parent / "samples"
TODAY = dt.date(2026, 10, 8)  # a Thursday, before every date in the sample file


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    monkeypatch.setattr(blog_plan, "_today", lambda: TODAY)
    monkeypatch.setattr(blog_plan, "_table_ready", True)


def _auth(sub="u1"):
    claims = {"sub": sub, "email": f"{sub}@x.co", "aud": "authenticated", "exp": int(time.time()) + 60}
    return {"Authorization": f"Bearer {jwt.encode(claims, SECRET, algorithm='HS256')}"}


def _sample(name="blog_plan.sample.json"):
    return json.loads((SAMPLES / name).read_text())


# ---------- Validation ----------


def test_sample_file_is_valid():
    entries, errors, warnings = blog_plan.validate(_sample(), TODAY)
    assert errors == [] and warnings == []
    assert [e["external_id"] for e in entries] == [f"BLG-00{n}" for n in range(1, 7)]
    first = entries[0]
    assert first["publish_date"] == dt.date(2026, 10, 12) and first["keywords"] == ["AIDL", "HIDL", "Treble"]


def test_invalid_file_reports_every_problem():
    entries, errors, warnings = blog_plan.validate(_sample("blog_plan.invalid.json"), TODAY)
    found = {(e["id"], e["field"]) for e in errors}
    assert ("BLG-101", "topic") in found  # missing topic
    assert ("BLG-102", "publish_date") in found  # 2026-13-40 is not a date
    assert ("BLG-103", "publish_date") in found  # in the past
    assert ("BLG-104", "reference_urls") in found  # ftp:// link
    assert ("BLG-104", "id") in found  # used twice
    assert ("BLG-105", "keywords") in found  # empty list
    assert {"id": "BLG-105", "field": "category", "message": '"Linux" is not a usual category.'} in warnings
    assert entries == []  # every entry in that file has an error


@pytest.mark.parametrize("payload", [None, [], {"blogs": []}, {"blogs": "x"}, {"posts": [{}]}])
def test_file_needs_a_blogs_list(payload):
    _, errors, _ = blog_plan.validate(payload, TODAY)
    assert errors and errors[0]["field"] == "blogs"


def test_too_many_entries():
    one = _sample()["blogs"][0]
    _, errors, _ = blog_plan.validate({"blogs": [one] * 61}, TODAY)
    assert "At most 60" in errors[0]["message"]


def test_two_blogs_on_one_day_is_a_warning():
    blogs = _sample()["blogs"][:2]
    blogs[1]["publish_date"] = blogs[0]["publish_date"]
    entries, errors, warnings = blog_plan.validate({"blogs": blogs}, TODAY)
    assert len(entries) == 2 and not errors and "2 blogs are planned" in warnings[0]["message"]


def test_optional_fields_can_be_left_out():
    entry = {"id": "BLG-9", "topic": "A topic long enough", "category": "AOSP", "keywords": ["x"],
             "publish_date": "2026-10-20"}
    entries, errors, _ = blog_plan.validate({"blogs": [entry]}, TODAY)
    assert not errors and entries[0]["tone"] is None and entries[0]["reference_urls"] == []


# ---------- Routes (fake database) ----------


class FakeConn:
    def __init__(self, db):
        self.db = db

    def transaction(self):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def fetch(self, sql, ids):
        return [{"external_id": i, "posted": self.db.rows[i]["posted"]} for i in ids if i in self.db.rows]

    async def execute(self, sql, *args):
        self.db.saved.append(args[0])


class FakeDB:
    """Pool stand-in: `rows` = briefs already saved ({external_id: {"posted": bool}}), `role` = the caller's role."""

    def __init__(self):
        self.rows: dict[str, dict] = {}
        self.saved: list[str] = []
        self.role = "admin"
        self.plan_rows: list[dict] = []

    def acquire(self):
        return FakeConn(self)

    async def fetchval(self, sql, *_args):
        assert "raw_app_meta_data->>'role'" in sql
        return self.role

    async def fetch(self, sql, *_args):
        return self.plan_rows

    async def fetchrow(self, sql, plan_id):
        return next((r for r in self.plan_rows if r["id"] == plan_id), None)

    async def execute(self, sql, plan_id):
        assert "set status = 'cancelled'" in sql
        for r in self.plan_rows:
            if r["id"] == plan_id:
                r["plan_status"] = "cancelled"


@pytest.fixture
def db(monkeypatch):
    fake = FakeDB()

    async def pg():
        return fake

    monkeypatch.setattr(data, "_pg", pg)
    monkeypatch.setattr(blog_plan, "_pg", pg)
    return fake


def _upload(body, dry_run=False, sub="u1"):
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    return client.post(f"/blogs/plan/import{'?dry_run=true' if dry_run else ''}", content=raw, headers=_auth(sub))


def test_import_needs_admin(db):
    db.role = "employee"
    res = _upload(_sample())
    assert res.status_code == 403 and db.saved == []


def test_dry_run_saves_nothing(db):
    res = _upload(_sample(), dry_run=True).json()
    assert res["saved"] is False and res["created"] == 0 and db.saved == []
    assert [i["action"] for i in res["items"]] == ["new"] * 6


def test_import_creates_updates_and_skips_posted(db):
    db.rows = {"BLG-001": {"posted": False}, "BLG-002": {"posted": True}}
    res = _upload(_sample()).json()
    assert res["saved"] and (res["created"], res["updated"], res["skipped"]) == (4, 1, 1)
    assert "BLG-002" not in db.saved and len(db.saved) == 5


def test_import_with_errors_saves_nothing(db):
    res = _upload(_sample("blog_plan.invalid.json"))
    assert res.status_code == 422 and db.saved == []
    assert res.json()["detail"]["errors"]


def test_not_json_and_too_large(db):
    assert _upload(b"{not json").status_code == 400
    assert _upload(b" " * (blog_plan.MAX_BYTES + 1)).status_code == 413


def _row(eid, day, plan="planned", post=None, post_id=None):
    return {"id": f"id-{eid}", "external_id": eid, "topic": "t", "category": "HAL", "keywords": [],
            "publish_date": day, "tone": None, "length": None, "target_versions": [], "reference_urls": [],
            "plan_status": plan, "uploaded_by": None, "created_at": None, "updated_at": None,
            "post_id": post_id, "post_status": post, "post_url": None}


def test_status_is_derived():
    today = TODAY
    assert blog_plan._status(_row("a", dt.date(2026, 10, 12)), today) == "planned"
    assert blog_plan._status(_row("a", dt.date(2026, 10, 1)), today) == "missed"
    assert blog_plan._status(_row("a", dt.date(2026, 10, 1), post="drafted", post_id="p"), today) == "written"
    assert blog_plan._status(_row("a", dt.date(2026, 10, 1), post="published", post_id="p"), today) == "posted"
    assert blog_plan._status(_row("a", dt.date(2026, 10, 12), plan="cancelled"), today) == "cancelled"


def test_plan_summary(db, monkeypatch):
    monkeypatch.setattr(blog_plan, "_plain", lambda r: {"externalId": r["external_id"],
                                                        "publishDate": r["publish_date"].isoformat(),
                                                        "planStatus": r["plan_status"], "postStatus": r["post_status"]})
    db.plan_rows = [
        _row("BLG-0", dt.date(2026, 10, 6)),  # this week, already past -> missed
        _row("BLG-1", dt.date(2026, 10, 9)),  # this week -> planned
        _row("BLG-2", dt.date(2026, 10, 12), plan="cancelled"),
        _row("BLG-3", dt.date(2026, 10, 15)),
    ]
    res = client.get("/blogs/plan", headers=_auth()).json()
    assert res["total"] == 3 and res["thisWeek"] == 2
    assert res["byStatus"] == {"missed": 1, "planned": 2, "cancelled": 1}
    assert res["next"]["externalId"] == "BLG-1"


def test_plan_needs_login():
    assert client.get("/blogs/plan").status_code == 401
    assert client.post("/blogs/plan/import", content=b"{}").status_code == 401


def test_cancel(db):
    db.plan_rows = [_row("BLG-1", dt.date(2026, 10, 12)),
                    _row("BLG-2", dt.date(2026, 10, 15), post="published", post_id="p")]
    res = client.post("/blogs/plan/id-BLG-1/cancel", headers=_auth())
    assert res.status_code == 200 and res.json()["status"] == "cancelled"
    assert client.post("/blogs/plan/id-BLG-2/cancel", headers=_auth()).status_code == 409  # already posted
    assert client.post("/blogs/plan/id-nope/cancel", headers=_auth()).status_code == 404
    db.role = "employee"
    assert client.post("/blogs/plan/id-BLG-2/cancel", headers=_auth()).status_code == 403
