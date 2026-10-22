"""Replies the dashboard reads from Gmail itself, and the labels people give replies on Positive Leads.

The mail agent only sends; this backend reads every reply. POST /inbox/check reads the connected mailbox (app/gmail.py,
read only): every message but our sent mail, drafts, chats, spam and trash (archived replies count), up to
MAX_PER_CHECK new ones per check. It also runs on its own every INBOX_CHECK_EVERY_MINUTES when that is set (app/main.py).
  - our own mail and Gmail SENT messages are skipped;
  - mailer-daemon / postmaster / Exchange notices and delivery reports are bounces;
  - a message is a reply when its In-Reply-To / References name an email we sent ('header'), or it is in the Gmail
    conversation of one ('thread'), or it comes from the address of a lead we emailed ('sender': e.g. a new thread);
  - out-of-office replies are recognised by their headers and subject (app/reply_rules.py).
Each message is looked at once (inbox_seen), unless the reply or bounce saved from it has since been deleted (e.g. by
a test-lead cleanup): then it is read again. Another exception: mail judged
"not a reply" is looked at again (recent mail only, a few per check) when one of our emails was recorded after it was
seen, so a reply that arrived before its lead or email was in the database is still found. Nothing is ever sent,
labelled, marked as read or deleted in Gmail, and the agent's tables (emails, contacts, ...) are only read. The one
exception is a person's Unsubscribe label, which puts the reply's addresses on the agent's do-not-email list (migration
012).

  POST /inbox/check  -> { checked, newReplies, processed, remaining, rechecked, followUpsChecked, since,
                          repliesWithoutLead }
  POST /inbox/label  { replyId, label | null } -> { ok }: a person's label for a reply (null removes it); unsubscribe
                     also stops the mail agent emailing that address

Needs migrations/007_inbox_replies.sql; until it has been run both answer 503 saying so. Errors are 503 / 502 with a
readable detail, never 401 / 409 (the dashboard signs the user out on those).
"""

import asyncio
import json
import logging
import os
import re
import time
import uuid
from datetime import UTC, datetime
from typing import Annotated, Literal

import asyncpg
import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import data, gmail, reply_rules
from app.auth import current_user

log = logging.getLogger(__name__)
router = APIRouter(prefix="/inbox", dependencies=[Depends(current_user)])
User = Annotated[dict, Depends(current_user)]

LABELS = ("interested", "question", "not_interested", "unsubscribe", "ooo", "bounce")
BATCH = 25  # new messages fetched at a time
MAX_PER_CHECK = 200  # one check reads batches until it has caught up, at most this many messages
CHECK_SECONDS = 40  # or for this long; the rest are left for the next check
# Every message except our own sent mail, drafts and chats. Archived or filtered replies count too. Spam and trash
# are left out by the Gmail API itself.
SEARCH = "-in:sent -in:drafts -in:chats"
PAGE = 500  # Gmail's largest list page
MAX_PAGES = 20  # message ids listed per check, at most PAGE * MAX_PAGES
PARALLEL = 5  # messages fetched at once
THREADS_PER_CHECK = 10  # conversations looked at per check for an answer of ours
RECHECK_DAYS = 14  # mail judged "not a reply" is looked at again only while this recent
RECHECK_PER_CHECK = 25  # and at most this many per check
MIGRATION = "Run migrations/007_inbox_replies.sql in the Supabase SQL editor first."
SUPPRESS_MIGRATION = ("Not saved: an Unsubscribe label also stops the mail agent emailing them, which needs "
                      "migrations/012_unsubscribe_suppression.sql. Run it in the Supabase SQL editor first.")
_THREAD_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_lock = asyncio.Lock()  # one check at a time in this process; the unique Gmail ids guard the rest


class LabelIn(BaseModel):
    replyId: uuid.UUID  # an inbox_replies row
    label: Literal[LABELS] | None  # None: remove the person's label


# ---------- Check the inbox ----------


@router.post("/check")
async def check() -> dict:
    async with _lock:
        try:
            return await _check()
        except gmail.GmailError as exc:
            raise HTTPException(exc.status, str(exc)) from exc
        except asyncpg.UndefinedTableError as exc:
            raise HTTPException(503, MIGRATION) from exc
        except asyncpg.UndefinedColumnError as exc:
            raise HTTPException(503, data.SCORES_MIGRATION) from exc
        except asyncpg.PostgresError as exc:
            log.error("Inbox check failed in the database", exc_info=True)
            raise HTTPException(503, "Couldn't save what was read from Gmail: the database refused it. Try again.") from exc


async def _connection(pool: asyncpg.Pool) -> asyncpg.Record:
    try:
        row = await pool.fetchrow("select email, refresh_token from gmail_connection where id = 1")
    except asyncpg.UndefinedTableError:
        row = None  # migration 006 not run: nobody can have connected Gmail
    if not row:
        raise gmail.GmailError(503, gmail.NOT_CONNECTED)
    return row


async def _check() -> dict:
    pool = await data._pg()
    conn = await _connection(pool)
    # No reply can be older than our first email, so that is where reading starts (a day earlier for time zones).
    start = await pool.fetchval(
        "select min(sent_at) from emails where status in ('sent', 'bounced') and sent_at is not null"
    )
    if start is None:
        return {"checked": 0, "newReplies": 0, "processed": 0, "remaining": 0, "rechecked": 0, "followUpsChecked": 0,
                "since": None, "repliesWithoutLead": 0}
    async with gmail.client() as http:
        token = await gmail.access_token(http, conn["refresh_token"])
        ids = await _list_ids(http, token, f"{SEARCH} after:{int(start.timestamp()) - 86400}")
        known = {r["gmail_message_id"] for r in await pool.fetch(_KNOWN, ids)}
        fresh = [i for i in reversed(ids) if i not in known]  # Gmail lists newest first: read the oldest first
        new_replies = processed = 0
        deadline = time.monotonic() + CHECK_SECONDS
        while fresh and processed < MAX_PER_CHECK and time.monotonic() < deadline:
            batch, fresh = fresh[:BATCH], fresh[BATCH:]
            for gid, msg in zip(batch, await _fetch_all(http, token, batch), strict=True):
                outcome, stored = await _process(pool, gid, msg, conn["email"].lower())
                new_replies += stored
                log.info("Inbox message %s: %s", gid, outcome)
            processed += len(batch)
        rechecked, found = await _recheck(pool, http, token, conn["email"].lower())
        follow_ups = await _refresh_follow_ups(pool, http, token)
        # Saved replies whose lead is gone: Positive Leads lists leads, so these are not shown; the page says so.
        without_lead = await pool.fetchval(
            """select count(*) from inbox_replies s
                where s.auto_label is null and not exists (select 1 from contacts c where c.id = s.contact_id)"""
        )
    return {"checked": len(ids), "newReplies": new_replies + found, "processed": processed,
            "remaining": len(fresh), "rechecked": rechecked, "followUpsChecked": follow_ups,
            "since": start.isoformat(), "repliesWithoutLead": without_lead or 0}


async def check_every(minutes: float) -> None:
    """The check on its own, every `minutes`, while this server runs (started by app/main.py when
    INBOX_CHECK_EVERY_MINUTES is set), so replies are read even when nobody has Positive Leads open."""
    while True:
        await asyncio.sleep(minutes * 60)
        try:
            async with _lock:
                result = await _check()
            log.info("Scheduled inbox check: %s", {k: v for k, v in result.items() if k != "since"})
        except asyncio.CancelledError:
            raise
        except gmail.GmailError as exc:
            log.warning("Scheduled inbox check skipped: %s", exc)
        except Exception:  # noqa: BLE001 - keep checking on the next round
            log.error("Scheduled inbox check failed", exc_info=True)


def check_interval() -> float | None:
    """INBOX_CHECK_EVERY_MINUTES as a number of minutes, or None (not set, 0 or not a number): no scheduled check."""
    try:
        minutes = float(os.environ.get("INBOX_CHECK_EVERY_MINUTES", "").strip() or 0)
    except ValueError:
        log.error("INBOX_CHECK_EVERY_MINUTES is not a number; the scheduled inbox check is off")
        return None
    return max(minutes, 1.0) if minutes > 0 else None


# Messages already looked at. A reply or bounce whose saved row was deleted since is not "known": it is read again.
_KNOWN = """
select n.gmail_message_id from inbox_seen n
where n.gmail_message_id = any($1::text[])
  and not (n.outcome in ('reply', 'bounce')
           and not exists (select 1 from inbox_replies s where s.gmail_message_id = n.gmail_message_id))
"""


async def _recheck(pool: asyncpg.Pool, http: httpx.AsyncClient, token: str, own: str) -> tuple[int, int]:
    """Mail once judged "not a reply", looked at again when one of our emails was recorded after it was seen (a lead or
    email added later, e.g. by hand, would otherwise never be matched). Only mail from the last RECHECK_DAYS, at most
    RECHECK_PER_CHECK per check; a message that still matches nothing waits for the next new email of ours.
    -> (messages looked at again, replies found among them)."""
    newest = await pool.fetchval("select max(greatest(created_at, coalesce(updated_at, created_at))) from emails")
    if newest is None:
        return 0, 0
    waiting = [r["gmail_message_id"] for r in await pool.fetch(
        """select gmail_message_id from inbox_seen where outcome = 'not_reply' and seen_at < $1
            order by seen_at desc limit 500""",
        newest,
    )]
    if not waiting:
        return 0, 0
    recent = set(await _list_ids(http, token, f"{SEARCH} newer_than:{RECHECK_DAYS}d"))
    again = [g for g in waiting if g in recent][:RECHECK_PER_CHECK]
    found = 0
    for gid, msg in zip(again, await _fetch_all(http, token, again), strict=True):
        outcome, stored = await _process(pool, gid, msg, own)
        found += stored
        log.info("Inbox message %s looked at again: %s", gid, outcome)
    return len(again), found


async def _list_ids(http: httpx.AsyncClient, token: str, query: str) -> list[str]:
    ids: list[str] = []
    page_token = None
    for _ in range(MAX_PAGES):
        params = {"q": query, "maxResults": PAGE, **({"pageToken": page_token} if page_token else {})}
        page = await gmail.get(http, token, "/messages", params) or {}
        ids += [m["id"] for m in page.get("messages") or []]
        page_token = page.get("nextPageToken")
        if not page_token:
            break
    return ids


async def _fetch_all(http: httpx.AsyncClient, token: str, ids: list[str]) -> list[dict | None]:
    gate = asyncio.Semaphore(PARALLEL)

    async def one(gid: str) -> dict | None:
        async with gate:
            return await gmail.get(http, token, f"/messages/{gid}", {"format": "full"})

    return await asyncio.gather(*(one(g) for g in ids))


async def _match(pool: asyncpg.Pool, m: dict, *, by_sender: bool) -> tuple[asyncpg.Record | None, str | None]:
    """The email of ours this message belongs to, and how we know: Message-ID headers, Gmail conversation, sender."""
    refs = reply_rules.message_ids(m["in_reply_to"], m["references"])
    if refs:
        row = await pool.fetchrow(
            "select e.id, e.contact_id from emails e where e.message_id = any($1::text[]) "
            "order by e.sent_at desc nulls last limit 1",
            refs,
        )
        if row:
            return row, "header"
    if m["thread_id"]:
        row = await pool.fetchrow(
            "select e.id, e.contact_id from emails e where e.gmail_thread_id = $1 and e.status in ('sent', 'bounced') "
            "order by e.sent_at desc nulls last limit 1",
            m["thread_id"],
        )
        if row:
            return row, "thread"
    if by_sender and m["from_email"]:
        row = await pool.fetchrow(
            "select e.id, e.contact_id from emails e join contacts c on c.id = e.contact_id "
            "where lower(c.email) = $1 and e.status = 'sent' order by e.sent_at desc limit 1",
            m["from_email"],
        )
        if row:
            return row, "sender"
    return None, None


async def _process(pool: asyncpg.Pool, gid: str, msg: dict | None, own: str) -> tuple[str, bool]:
    """Stores one message if it answers us, and records that it was seen. -> (outcome, a new reply was stored)."""
    if msg is None:  # deleted from Gmail since it was listed
        await _seen(pool, gid, "not_reply")
        return "not_reply", False
    m = gmail.parse(msg)
    if m["from_email"] == own or "SENT" in m["labels"]:
        await _seen(pool, gid, "own")
        return "own", False
    auto_label = None
    if reply_rules.is_bounce(m["from_email"], m["subject"], m["headers"]):
        email, method = await _match(pool, m, by_sender=False)
        if not email:  # the notice usually quotes our Message-ID
            quoted = reply_rules.message_ids(m["text"])
            email = quoted and await pool.fetchrow(
                "select e.id, e.contact_id from emails e where e.message_id = any($1::text[]) limit 1", quoted
            )
            method = "header" if email else None
        if not email:
            await _seen(pool, gid, "bounce_unmatched")
            return "bounce_unmatched", False
        auto_label, outcome = "bounce", "bounce"
    else:
        email, method = await _match(pool, m, by_sender=True)
        if not email:
            await _seen(pool, gid, "not_reply")
            return "not_reply", False
        if reply_rules.is_auto_reply(m["headers"], m["subject"]):
            auto_label = "ooo"
        outcome = "reply"
    # A person's reply is scored once, here, and Positive Leads reads the saved score (migrations/013). Automatic mail
    # (out-of-office, bounce) isn't listed there: it is scored only if a person relabels it.
    scored = None
    if auto_label is None:
        ours = await pool.fetchval("select body from emails where id = $1", email["id"])
        scored = json.dumps(reply_rules.score_saved(m["text"], ours))
    async with pool.acquire() as c, c.transaction():
        stored = await c.fetchval(
            """insert into inbox_replies (gmail_message_id, gmail_thread_id, message_id, email_id, contact_id,
                                          match_method, from_email, subject, body, received_at, auto_label,
                                          score_data, scored_with)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
               on conflict (gmail_message_id) do nothing returning id""",
            gid, m["thread_id"], m["message_id"], email["id"], email["contact_id"], method, m["from_email"],
            m["subject"][:1000] or None, m["text"], m["received_at"], auto_label,
            scored, reply_rules.RULES_VERSION if scored else None,
        )  # fmt: skip
        await c.execute(_SEEN, gid, outcome)
    return outcome, stored is not None and auto_label is None


# A message looked at again gets its new outcome and time (so it isn't looked at again until our next new email).
_SEEN = """insert into inbox_seen (gmail_message_id, outcome) values ($1, $2)
           on conflict (gmail_message_id) do update set outcome = excluded.outcome, seen_at = now()"""


async def _seen(pool: asyncpg.Pool, gid: str, outcome: str) -> None:
    await pool.execute(_SEEN, gid, outcome)


async def _refresh_follow_ups(pool: asyncpg.Pool, http: httpx.AsyncClient, token: str) -> int:
    """For replies not answered yet as far as we know: a later message of ours (Gmail SENT) in the same conversation
    means we answered. A few conversations per check, the least recently looked at first."""
    rows = await pool.fetch(
        """select id, gmail_thread_id, received_at from inbox_replies
            where we_replied_at is null and auto_label is null and gmail_thread_id is not null
            order by thread_checked_at nulls first, received_at desc limit $1""",
        THREADS_PER_CHECK,
    )
    for r in rows:
        if not _THREAD_ID.match(r["gmail_thread_id"]):
            continue
        thread = await gmail.get(http, token, f"/threads/{r['gmail_thread_id']}",
                                 {"format": "metadata", "metadataHeaders": "From"}) or {}
        after = r["received_at"].timestamp() * 1000
        sent = [int(m.get("internalDate") or 0) for m in thread.get("messages") or []
                if "SENT" in (m.get("labelIds") or []) and int(m.get("internalDate") or 0) > after]
        answered = datetime.fromtimestamp(min(sent) / 1000, UTC) if sent else None
        await pool.execute(
            "update inbox_replies set we_replied_at = $2, thread_checked_at = now() where id = $1", r["id"], answered
        )
    return len(rows)


# ---------- A person's label ----------


@router.post("/label")
async def label(body: LabelIn, user: User) -> dict:
    """Shown instead of any automatic label from now on. Labelling a reply unsubscribe also puts its addresses (the
    sender and the lead) on the mail agent's do-not-email list, and taking that label back lifts what was added
    (migration 012: the backend can only do this through its functions). Nothing is sent. reply_labels.source is always
    'inbox' (the column is from when the agent's replies could be labelled too)."""
    by = user.get("email") or user["sub"]
    try:
        pool = await data._pg()
        async with pool.acquire() as conn, conn.transaction():
            if not await conn.fetchval("select exists (select 1 from inbox_replies where id = $1)", body.replyId):
                raise HTTPException(404, "This reply no longer exists.")
            before = await conn.fetchval(
                "select label from reply_labels where source = 'inbox' and reply_id = $1 for update", body.replyId)
            if body.label is None:
                await conn.execute("delete from reply_labels where source = 'inbox' and reply_id = $1", body.replyId)
            else:
                await conn.execute(
                    """insert into reply_labels (source, reply_id, label, labelled_by) values ('inbox', $1, $2, $3)
                       on conflict (source, reply_id) do update
                         set label = excluded.label, labelled_by = excluded.labelled_by, labelled_at = now()""",
                    body.replyId, body.label, by,
                )  # fmt: skip
            if body.label == "unsubscribe":
                await conn.fetchval("select dashboard_suppress($1, $2)", body.replyId, by)
            elif before == "unsubscribe":
                await conn.fetchval("select dashboard_unsuppress($1)", body.replyId)
    except asyncpg.UndefinedTableError as exc:
        raise HTTPException(503, MIGRATION) from exc
    except asyncpg.UndefinedFunctionError as exc:
        raise HTTPException(503, SUPPRESS_MIGRATION) from exc
    except asyncpg.PostgresError as exc:
        log.error("Could not save the label", exc_info=True)
        raise HTTPException(503, "Couldn't save the label: the database refused it. Try again.") from exc
    return {"ok": True}
