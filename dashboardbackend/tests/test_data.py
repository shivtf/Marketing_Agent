import secrets
import time

import jwt
import pytest
from fastapi.testclient import TestClient

from app import data, reply_rules
from app.main import app

SECRET = secrets.token_hex(32)  # random each run: signs fake test tokens only, never a real key
client = TestClient(app)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)


def _auth():
    claims = {"sub": "u1", "aud": "authenticated", "exp": int(time.time()) + 60, "app_metadata": {"role": "employee"}}
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
        "noContact": 0,
        "awaiting": 1,
        "responded": 1,
        "bounced": 1,
        "bySource": {"search": 3, "hn_hiring": 2},
    }


def _reply(id_, label="interested", body="Hi Alex,\n\nSounds good.\n\nThanks", at="2026-10-01", answered=None,
           labelled=True, lead=None):
    """One reply as the /leads/positive query returns it (lead: its lead, by default a lead of its own).
    labelled: a person chose `label`."""
    return {"id": id_, "leadId": lead or f"lead-{id_}", "label": label, "body": body, "sentBody": None,
            "repliedAt": at,
            "answeredAt": answered, "labelledAt": "2026-10-02T09:00:00+00:00" if labelled else None}


@pytest.fixture
def positive_rows(monkeypatch):
    """Serve the given rows to /leads/positive, with 9 leads that replied in person (labelled or not)."""
    def use(rows):
        async def fake_rows(sql, *_):
            return [dict(r) for r in rows]

        async def fake_value(sql, *_):
            assert "status = 'Responded'" in sql
            return 9

        monkeypatch.setattr(data, "_rows", fake_rows)
        monkeypatch.setattr(data, "_value", fake_value)
    return use


def test_positive_leads_groups(positive_rows):
    positive_rows([
        _reply("a", "interested"),
        _reply("b", None, body="Maybe, depends on timing.", labelled=False),  # no label, no keyword
        _reply("h", None, body="Yes, let's talk next week.", labelled=False),  # no label: the keyword score decides
        _reply("c", "question"),
        _reply("d", None, body="Not right now, but let's talk in Q2", labelled=False),  # says yes and no
        _reply("e", "not_interested"),
        _reply("f", "unsubscribe"),
        _reply("g", None, body="Please remove me from your list.", labelled=False),  # seems to ask to stop
    ])
    res = client.get("/leads/positive", headers=_auth()).json()
    assert [r["id"] for r in res["positive"]] == ["a", "h"]  # equal wait: stable sort keeps input order
    assert [r["id"] for r in res["review"]] == ["b", "d"]
    reasons = {r["id"]: r["reviewReason"] for r in res["review"]}
    assert reasons == {"b": "No keywords matched", "d": "Score 0.55: says both yes and no"}
    h = res["positive"][1]
    assert h["score"] == 0.75 and h["scoreHits"] == [{"phrase": "let's talk", "weight": 0.25}]
    assert [r["id"] for r in res["questions"]] == ["c"]
    assert [(r["id"], r["followUp"]) for r in res["notInterested"]] == [("e", "none")]
    # A person's "unsubscribe" closes the lead; one only guessed from the wording still waits on us.
    assert [(r["id"], r["followUp"]) for r in res["unsubscribe"]] == [("g", "waiting"), ("f", "none")]
    assert res["repliedLeads"] == 9
    assert set(res) == {"positive", "review", "questions", "notInterested", "unsubscribe", "repliedLeads"}
    assert all("body" not in r and "sentBody" not in r and "labelledAt" not in r for r in res["positive"])
    assert res["positive"][0]["labelledByPerson"] is True and res["review"][0]["labelledByPerson"] is False


def test_positive_leads_follow_up_order(positive_rows):
    positive_rows([
        _reply("replied-new", at="2026-10-05", answered="2026-10-05T12:00:00"),
        _reply("waiting-new", at="2026-10-04"),
        _reply("replied-old", at="2026-10-03", answered="2026-10-03T12:00:00"),
        _reply("waiting-old", at="2026-10-01"),
    ])
    res = client.get("/leads/positive", headers=_auth()).json()["positive"]
    # waiting first (longest-waiting on top), then the rest newest first
    assert [r["id"] for r in res] == ["waiting-old", "waiting-new", "replied-new", "replied-old"]
    assert [r["followUp"] for r in res] == ["waiting", "waiting", "replied", "replied"]


def test_every_reply_of_a_lead_stays_on_the_page(positive_rows):
    # Carl said yes, then no: both emails are listed, each in its own group. The older one is not "waiting": he wrote
    # again since.
    positive_rows([
        _reply("yes", "interested", at="2026-10-01", lead="carl"),
        _reply("no", "not_interested", at="2026-10-05", lead="carl"),
        _reply("again", "interested", at="2026-10-03", lead="priya"),
        _reply("latest", "interested", at="2026-10-04", lead="priya"),
    ])
    res = client.get("/leads/positive", headers=_auth()).json()
    assert [(r["id"], r["followUp"]) for r in res["positive"]] == [
        ("latest", "waiting"), ("again", "later"), ("yes", "later")]
    assert [(r["id"], r["leadId"]) for r in res["notInterested"]] == [("no", "carl")]


def test_positive_leads_preview(positive_rows):
    positive_rows([_reply("a", "interested", body=f"Hi Alex,\n\n{'x' * 150}\n\nThanks")])
    (item,) = client.get("/leads/positive", headers=_auth()).json()["positive"]
    assert item["preview"] == "x" * 99 + "…"


def test_preview_drops_greeting_and_quoted_mail():
    body = (
        "Hi Alex,\n\nYes, a call on Thursday works.\nSend me two time slots.\n\n"
        "On Mon, 5 Oct 2026 at 10:00, Alex <alex@agency.example> wrote:\n> Would you like a call?"
    )
    assert reply_rules.preview(body) == "Yes, a call on Thursday works. Send me two time slots."
    assert reply_rules.preview("> only quoted text") == ""
    assert reply_rules.preview(None) == ""


def test_concurrent_first_requests_share_one_pool(monkeypatch):
    import asyncio

    created = []

    async def create_pool(*_a, **_k):
        await asyncio.sleep(0.01)  # let the other requests arrive while the pool is being made
        created.append(object())
        return created[-1]

    monkeypatch.setenv("DATABASE_URL", "postgresql://example/db")
    monkeypatch.setattr(data, "_pool", None)
    monkeypatch.setattr(data, "_pool_lock", asyncio.Lock())
    monkeypatch.setattr(data.asyncpg, "create_pool", create_pool)

    async def five_at_once():
        return await asyncio.gather(*(data._pg() for _ in range(5)))

    pools = asyncio.run(five_at_once())
    assert len(created) == 1 and all(p is created[0] for p in pools)


# ---------- History: search and filters ----------


def test_sent_emails_search_status_and_failed_count(db):
    calls, answer = db
    answer.update(rows=[{"id": "e", "number": 1, "deliveryStatus": "Failed"}], value=3)
    res = client.get("/emails/sent?q=%20Acme%25%20&status=failed&page=2&limit=10", headers=_auth()).json()
    assert res["failed"] == 3 and res["page"] == 2
    count_sql, count_args = calls[0]
    # the search text is a plain argument (lower-cased, trimmed; % is not a wildcard), never part of the SQL
    assert count_args == ("acme%", "Failed") and "acme" not in count_sql
    assert "strpos(lower(coalesce(\"to\", '')), $1) > 0" in count_sql and "delivery_status = $2" in count_sql
    assert calls[1][1] == ("acme%", "Failed", 10, 10)
    assert "delivery_status = 'Failed'" in calls[2][0]  # failed count is over all sent emails, not the filter


def test_sent_emails_without_filters(db):
    calls, _ = db
    client.get("/emails/sent", headers=_auth())
    assert ") t where" not in calls[0][0] and calls[0][1] == ()


def test_history_filters_are_checked(db):
    assert client.get("/emails/sent?status=delivered", headers=_auth()).status_code == 422
    assert client.get(f"/emails/sent?q={'x' * 101}", headers=_auth()).status_code == 422


# ---------- One lead: the reply it is judged on ----------


@pytest.fixture
def lead_db(monkeypatch):
    """Fake pool for /leads/{id}: the lead, its latest human reply (`reply`, None = no reply) and latest sent email."""
    import datetime as dt

    state = {"reply": {"id": "r1", "label": None, "email_id": "e0", "labelled_by": None, "labelled_at": None,
                       "received_at": dt.datetime(2026, 10, 5, 9, 30, tzinfo=dt.UTC), "sent_body": None,
                       "body": "Hi Alex,\n\nYes, let's talk.\n\nOn Mon, 5 Oct 2026, Alex <a@x.co> wrote:\n> Interested?"}}

    async def one(*_):
        return {"id": "a", "number": 1, "name": "Sam"}

    class Pool:
        async def fetchrow(self, sql, *_):
            return state["reply"] if "labelled_by" in sql else {"id": "e1"}

    async def pg():
        return Pool()

    monkeypatch.setattr(data, "_one", one)
    monkeypatch.setattr(data, "_pg", pg)
    return state


def test_lead_includes_what_the_person_wrote(lead_db):
    res = client.get("/leads/7d4c1a52-3f0e-4b8a-9c6d-2e1f0a9b8c7d", headers=_auth()).json()
    assert res["latestReply"] == {"id": "r1", "receivedAt": "2026-10-05T09:30:00+00:00",
                                  "text": "Hi Alex,\n\nYes, let's talk."}  # quoted earlier mail left out
    assert res["conversation"] == {"type": "reply", "id": "r1"} and "notes" not in res
    # Not labelled: its keyword score ("let's talk", +0.25) puts it in Positive.
    assert res["replyGroup"] == "positive" and res["labelledBy"] is None and res["score"] == 0.75
    assert res["scoreHits"] == [{"phrase": "let's talk", "weight": 0.25}]


def test_lead_reply_that_is_all_quoted_is_shown_whole(lead_db):
    lead_db["reply"]["body"] = "> only quoted text"
    res = client.get("/leads/7d4c1a52-3f0e-4b8a-9c6d-2e1f0a9b8c7d", headers=_auth()).json()
    assert res["latestReply"]["text"] == "> only quoted text"


def test_lead_without_a_reply(lead_db):
    lead_db["reply"] = None
    res = client.get("/leads/7d4c1a52-3f0e-4b8a-9c6d-2e1f0a9b8c7d", headers=_auth()).json()
    assert res["latestReply"] is None and res["conversation"] == {"type": "sent", "id": "e1"}
    assert res["score"] is None and res["scoreHits"] == []
