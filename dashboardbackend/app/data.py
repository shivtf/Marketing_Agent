"""Read-only data routes for the dashboard.

Reads the tables the lead / outreach / content services write to (supabase/migrations/0002_core.sql)
and returns the same shapes the dashboard's mock data used (eval/dashboard/core/data.js), so the
frontend only has to swap its mock bodies for apiFetch() calls. Every route requires a Supabase login.
Once migrations/007_inbox_replies.sql has been run, leads also take in the replies the dashboard read from Gmail
itself (app/inbox.py) and the labels people gave replies; until then everything reads exactly as before.
"""

import asyncio
import logging
import os
import re
import time
import uuid
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import current_user
from app.reply_rules import mentions_unsubscribe

log = logging.getLogger(__name__)
router = APIRouter(dependencies=[Depends(current_user)])

_pool: asyncpg.Pool | None = None
_pool_lock = asyncio.Lock()  # the dashboard sends several requests at once; they must share one pool

# A lead is a contact of a company, or a company still in the pipeline that has no contact yet ('No Contact': qualified,
# or waiting for a person on Needs Contact). Companies the agent only discovered or rejected are not leads. Every lead
# gets a 1-based number (oldest first) so the UI can show "#12". A company's id is its own; a contact's is the contact's.
_LEADS = """
select x.*, row_number() over (order by x.added_at, x.id) as number from (
select c.id,
       coalesce(c.name, c.email, co.name) as name, c.role as title, co.name as company,
       'https://' || co.domain as company_url, co.source_url as profile_url, c.email,
       -- What the company does: the agent's project summary for it, else its industry.
       coalesce(nullif(btrim(co.project_summary), ''), nullif(btrim(co.industry), '')) as about,
       -- Where the agent found the lead: 'leadgen:search' -> 'search', 'leadgen:feed:hn_hiring' -> 'hn_hiring'.
       coalesce(nullif(regexp_replace(lower(coalesce(co.source, '')), '^(leadgen:)?(feed:)?', ''), ''), 'other')
         as source,
       -- Where outreach stands: a reply from a person wins (out-of-office and bounce messages are automatic, so
       -- they don't count), then a bounce, then a delivered email; otherwise nothing has been sent yet.
       case when exists (select 1 from replies r where r.contact_id = c.id
                                            and coalesce(r.label, '') not in ('ooo', 'bounce')){inbox_responded}
              then 'Responded'
            when exists (select 1 from emails e where e.contact_id = c.id and e.status = 'bounced')
              or exists (select 1 from replies r where r.contact_id = c.id and r.label = 'bounce'){inbox_bounced}
              then 'Bounced'
            when exists (select 1 from emails e where e.contact_id = c.id
                                                and e.status = 'sent' and e.sent_at is not null)
              then 'Sent'
            else 'Not Sent' end as status,
       c.collected_at as added_at, c.last_engaged_at as last_contact_at
from contacts c join companies co on co.id = c.company_id
union all
select co.id, co.name, null, co.name, 'https://' || co.domain, co.source_url, null,
       coalesce(nullif(btrim(co.project_summary), ''), nullif(btrim(co.industry), '')),
       coalesce(nullif(regexp_replace(lower(coalesce(co.source, '')), '^(leadgen:)?(feed:)?', ''), ''), 'other'),
       'No Contact', co.created_at, null
from companies co
where co.lead_status not in ('DISCOVERED', 'REJECTED')
  and not exists (select 1 from contacts c where c.company_id = co.id)
) x
"""

# Replies the dashboard read from Gmail count like the agent's, but only when they answer our email for sure (reply
# headers or the same Gmail conversation): a lead's address alone is not proof, so those wait for review instead.
_INBOX_RESPONDED = """
              or exists (select 1 from inbox_replies s
                         left join reply_labels hl on hl.source = 'inbox' and hl.reply_id = s.id
                         where s.contact_id = c.id and s.match_method in ('header', 'thread')
                           and coalesce(hl.label, s.auto_label, '') not in ('ooo', 'bounce'))"""
_INBOX_BOUNCED = """
              or exists (select 1 from inbox_replies s where s.contact_id = c.id and s.auto_label = 'bounce')"""


def _leads_sql(inbox: bool) -> str:
    return _LEADS.format(inbox_responded=_INBOX_RESPONDED if inbox else "",
                         inbox_bounced=_INBOX_BOUNCED if inbox else "")


async def _leads() -> str:
    return _leads_sql(await inbox_ready())


# ---------- Replies the dashboard read from Gmail (migrations/007_inbox_replies.sql) ----------

_INBOX_TABLES = """
select to_regclass('public.inbox_replies') is not null and to_regclass('public.inbox_seen') is not null
   and to_regclass('public.reply_labels') is not null
"""
_inbox: dict = {"ready": False, "checked": 0.0}


async def inbox_ready() -> bool:
    """Whether migration 007 has been run. A yes is kept; a no is asked again at most once a minute, so running the
    migration takes effect without a restart."""
    if _inbox["ready"]:
        return True
    if _inbox["checked"] and time.monotonic() - _inbox["checked"] < 60:
        return False
    try:
        ready = bool(await (await _pg()).fetchval(_INBOX_TABLES))
    except Exception:  # noqa: BLE001 - the page then reads as before; the query that follows reports a real outage
        log.warning("Could not check for the inbox tables", exc_info=True)
        return False
    _inbox.update(ready=ready, checked=time.monotonic())
    return ready

# delivery_status: 'Sent' means the agent sent it without an error (not proof it reached the inbox); 'Failed' = bounced.
_SENT = """
select * from (
  select e.id, row_number() over (order by e.sent_at, e.id) as number, e.contact_id as lead_id, co.name as company,
         e.mailbox as "from", c.email as "to", e.subject, e.sent_at,
         case e.status when 'bounced' then 'Failed' else 'Sent' end as delivery_status,
         {reply_id} as reply_id
  from emails e join contacts c on c.id = e.contact_id
  left join companies co on co.id = c.company_id
  where e.status in ('sent', 'bounced') and e.sent_at is not null
) s
"""

# The reply to a sent email: the agent's, else (once migration 007 exists) one the dashboard read from Gmail that
# surely answers it (reply headers or the same conversation, not just the sender's address).
_SENT_REPLY = "(select r.id from replies r where r.email_id = e.id order by r.received_at limit 1)"
_SENT_REPLY_INBOX = """coalesce(
           (select r.id from replies r where r.email_id = e.id order by r.received_at limit 1),
           (select s.id from inbox_replies s where s.email_id = e.id and s.match_method in ('header', 'thread')
            order by s.received_at limit 1))"""


def _sent_sql(inbox: bool) -> str:
    return _SENT.format(reply_id=_SENT_REPLY_INBOX if inbox else _SENT_REPLY)


async def _sent() -> str:
    return _sent_sql(await inbox_ready())


# Replies: the agent's, and once migration 007 exists also the ones the dashboard read from Gmail (replySource
# 'inbox'), with a person's label in place of the classifier's. Mail the agent also stored is listed once, as its.
# Numbered oldest first across both, so "#12" stays put while lists are filtered.
_REPLIES = """
select *, row_number() over (order by received_at, id) as number from (
  select r.id, coalesce(c.name, c.email) as sender_name, c.email as sender_email, e.mailbox as "to",
         'Re: ' || coalesce(e.subject, '') as subject, r.received_at, r.email_id as in_reply_to_id,
         {agent_label} as label, r.body, r.contact_id as lead_id, co.name as company, 'agent' as reply_source
  from replies r
  left join contacts c on c.id = r.contact_id
  left join companies co on co.id = c.company_id
  left join emails e on e.id = r.email_id{agent_join}{inbox}
) u
"""
_REPLIES_INBOX = """
  union all
  select s.id, coalesce(c.name, c.email, s.from_email), coalesce(c.email, s.from_email), e.mailbox,
         coalesce(s.subject, 'Re: ' || coalesce(e.subject, '')), s.received_at, s.email_id,
         coalesce(hl.label, s.auto_label), s.body, s.contact_id, co.name, 'inbox'
  from inbox_replies s
  left join contacts c on c.id = s.contact_id
  left join companies co on co.id = c.company_id
  left join emails e on e.id = s.email_id
  left join reply_labels hl on hl.source = 'inbox' and hl.reply_id = s.id
  where not exists (select 1 from replies r
                    where r.gmail_message_id = s.gmail_message_id or r.message_id = s.message_id)"""


def _replies_sql(inbox: bool) -> str:
    if not inbox:
        return _REPLIES.format(agent_label="r.label", agent_join="", inbox="")
    return _REPLIES.format(
        agent_label="coalesce(hl.label, r.label)",
        agent_join="\n  left join reply_labels hl on hl.source = 'agent' and hl.reply_id = r.id",
        inbox=_REPLIES_INBOX,
    )


async def _replies() -> str:
    return _replies_sql(await inbox_ready())

_BLOGS = """
select * from (
  select p.id, row_number() over (order by p.created_at, p.id) as number, p.title,
         case when p.status = 'published' then 'Posted' else 'Not Posted' end as status,
         case when p.devto_url is not null then 'Dev.to'
              when p.cms_url is not null then 'WordPress'
              when p.linkedin_url is not null then 'LinkedIn' end as site,
         coalesce(p.cms_url, p.devto_url, p.linkedin_url) as url,
         p.published_at as posted_at, p.body_md as content
  from content_posts p
) s
"""


async def _pg() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        async with _pool_lock:
            if _pool is None:  # another request may have created it while this one waited
                dsn = os.environ.get("DATABASE_URL", "").strip()
                if not dsn:
                    raise HTTPException(503, "DATABASE_URL is not set on the dashboard backend")
                # statement_cache_size=0: required behind pgbouncer / the Supabase transaction pooler.
                _pool = await asyncpg.create_pool(dsn, min_size=1, max_size=5, statement_cache_size=0)
    return _pool


async def _rows(sql: str, *args: Any) -> list[dict]:
    return [_plain(r) for r in await (await _pg()).fetch(sql, *args)]


async def _one(sql: str, *args: Any) -> dict:
    row = await (await _pg()).fetchrow(sql, *args)
    if row is None:
        raise HTTPException(404, "Not found")
    return _plain(row)


async def _value(sql: str, *args: Any) -> Any:
    return await (await _pg()).fetchval(sql, *args)


def _plain(row: asyncpg.Record) -> dict:
    """Record -> JSON-ready camelCase dict (uuids and datetimes become strings)."""
    out = {}
    for key, val in dict(row).items():
        head, *rest = key.split("_")
        out[head + "".join(w.title() for w in rest)] = (
            val.isoformat() if hasattr(val, "isoformat") else str(val) if isinstance(val, uuid.UUID) else val
        )
    return out


def _without(d: dict, *keys: str) -> dict:
    return {k: v for k, v in d.items() if k not in keys}


Source = Annotated[str | None, Query(pattern="^[a-z0-9_.:-]{1,40}$")]
Status = Annotated[str | None, Query(pattern="^(not_sent|sent|bounced|responded|no_contact)$")]
_STATUS = {"not_sent": "Not Sent", "sent": "Sent", "bounced": "Bounced", "responded": "Responded",
           "no_contact": "No Contact"}
PageNo = Annotated[int, Query(ge=1)]
Limit = Annotated[int, Query(ge=1, le=200)]
PAGE_SIZE = 50


async def _page(base: str, order: str, page: int, limit: int, where: str = "", args: tuple = ()) -> dict:
    """One page of `base` (a select) -> { items, total, page, limit }. Filters go in SQL (`where`, args $1..$n),
    so only the requested rows leave the database. `order` must end in a unique column for stable pages."""
    sql = f"select * from ({base}) t {where}"  # noqa: S608 - base/where/order are constants, values are args
    total = await _value(f"select count(*) from ({sql}) c", *args)  # noqa: S608
    n = len(args)
    items = await _rows(f"{sql} order by {order} limit ${n + 1} offset ${n + 2}", *args, limit, (page - 1) * limit)
    return {"items": items, "total": total or 0, "page": page, "limit": limit}

# ---------- Leads ----------


@router.get("/leads")
async def leads(
    status: Status = None, source: Source = None, page: PageNo = 1, limit: Limit = PAGE_SIZE
) -> dict:
    """Newest first: company and email; what the company does and other details are in /leads/{id}."""
    conds, args = [], []
    if status:
        args.append(_STATUS[status])
        conds.append(f"status = ${len(args)}")
    if source:
        args.append(source)
        conds.append(f"source = ${len(args)}")
    where = f"where {' and '.join(conds)}" if conds else ""
    out = await _page(await _leads(), "number desc", page, limit, where, tuple(args))
    hidden = ("title", "companyUrl", "profileUrl", "lastContactAt", "about")
    out["items"] = [_without(r, *hidden) for r in out["items"]]
    return out


@router.get("/leads/stats")
async def lead_stats() -> dict:
    rows = await _rows(f"select source, status, count(*) as n from ({await _leads()}) l group by 1, 2")  # noqa: S608
    by_source: dict[str, int] = {}
    for r in rows:
        by_source[r["source"]] = by_source.get(r["source"], 0) + r["n"]
    def count(status: str) -> int:
        return sum(r["n"] for r in rows if r["status"] == status)

    return {
        "total": sum(r["n"] for r in rows),
        "notSent": count("Not Sent"),
        "noContact": count("No Contact"),  # in the pipeline, no contact to email yet (see Needs Contact)
        "awaiting": count("Sent"),  # emailed, no reply yet
        "responded": count("Responded"),
        "bounced": count("Bounced"),
        "bySource": dict(sorted(by_source.items(), key=lambda kv: (-kv[1], kv[0]))),  # most leads first
    }


# Each lead's latest classified reply written by a person (out-of-office and bounces are automatic, so skipped).
# A lead is judged on this reply only, so a later "no" replaces an earlier "yes".
_LATEST_HUMAN_REPLY = """
select distinct on (r.contact_id) r.contact_id, r.id, r.email_id, r.received_at, r.label, r.review_note, r.body,
       'agent' as reply_source, null::text as match_method, null::timestamptz as we_replied_at,
       r.label as original_label, null::text as labelled_by, null::timestamptz as labelled_at
from replies r
where r.label is not null and r.label not in ('ooo', 'bounce')
order by r.contact_id, r.received_at desc
"""

# The same, once migration 007 exists: also the replies the dashboard read from Gmail ('inbox'), and a person's label
# (reply_labels) in place of the agent's. An inbox reply has no label until a person gives one. Mail the agent also
# stored (same Gmail id or Message-ID) is taken from the agent only.
_LATEST_HUMAN_REPLY_INBOX = """
select distinct on (contact_id) * from (
  select r.contact_id, r.id, r.email_id, r.received_at, coalesce(hl.label, r.label) as label,
         case when hl.label is null then r.review_note end as review_note, r.body,
         'agent' as reply_source, null::text as match_method, null::timestamptz as we_replied_at,
         r.label as original_label, hl.labelled_by, hl.labelled_at
  from replies r
  left join reply_labels hl on hl.source = 'agent' and hl.reply_id = r.id
  where coalesce(hl.label, r.label) not in ('ooo', 'bounce')
  union all
  select s.contact_id, s.id, s.email_id, s.received_at, coalesce(hl.label, s.auto_label), null, s.body,
         'inbox', s.match_method, s.we_replied_at, s.auto_label, hl.labelled_by, hl.labelled_at
  from inbox_replies s
  left join reply_labels hl on hl.source = 'inbox' and hl.reply_id = s.id
  where s.contact_id is not null and coalesce(hl.label, s.auto_label, '') not in ('ooo', 'bounce')
    and not exists (select 1 from replies r
                    where r.gmail_message_id = s.gmail_message_id or r.message_id = s.message_id)
) x
order by contact_id, received_at desc
"""


async def _latest_reply() -> str:
    return _LATEST_HUMAN_REPLY_INBOX if await inbox_ready() else _LATEST_HUMAN_REPLY

# The reply classifier records "confidence 0.42 < 0.6" in review_note when it isn't sure of the label.
_LOW_CONFIDENCE = re.compile(r"confidence\s+([\d.]+)\s*<", re.IGNORECASE)


def _review_reason(note: str | None) -> str | None:
    m = _LOW_CONFIDENCE.search(note or "")
    return f"Low confidence ({float(m.group(1)):.2f})" if m else None


# Labels whose low-confidence replies go to "Needs review" (a doubtful "no" may be a hidden "yes").
_REVIEWABLE = ("interested", "question", "not_interested")


def _judge(label: str | None, note: str | None, source: str, match: str | None, labelled: bool,
           body: str | None) -> tuple[str | None, str | None]:
    """Where a lead's latest reply goes on Positive Leads -> (group, why it needs review). group is positive /
    review / questions / notInterested / unsubscribe, or None (not listed). A person's label is trusted as given."""
    if label == "unsubscribe":
        return "unsubscribe", None
    if not labelled and mentions_unsubscribe(_strip_quoted(body)):
        # Safety net: whatever the label, a reply that seems to ask to stop is never shown as an ordinary lead. Only
        # what the person wrote is read: our own quoted email (and its unsubscribe footer) is left out.
        return "unsubscribe", "It seems to ask not to be contacted again"
    if not labelled and source == "inbox":
        if match == "sender":
            return "review", "Matched to this lead by the sender's address only"
        if label is None:
            return "review", "Read from Gmail, not labelled yet: read it and choose a label"
    reason = None if labelled else _review_reason(note)
    if reason and label in _REVIEWABLE:
        return "review", reason
    group = {"interested": "positive", "question": "questions", "not_interested": "notInterested"}.get(label or "")
    return group, None


def _follow_up_order(items: list[dict]) -> list[dict]:
    """Leads still waiting for our answer first (or whose follow-up is unknown), longest-waiting at the top; then the
    rest, newest reply first."""
    first = ("waiting", "unknown")
    waiting = sorted((r for r in items if r["followUp"] in first), key=lambda r: r["repliedAt"])
    rest = sorted((r for r in items if r["followUp"] not in first), key=lambda r: r["repliedAt"], reverse=True)
    return waiting + rest


@router.get("/leads/positive")
async def positive_leads() -> dict:
    """Leads judged on their latest human reply, split into positive (interested, confident),
    review (low confidence, or read from Gmail and not labelled yet), questions, notInterested (a confident "no") and
    unsubscribe (asked to stop, or seems to). followUp says whether we have answered that reply: 'replied' (sent),
    'queued' (approved, not sent yet), 'waiting', 'none' (a "no" that needs no answer), or 'unknown' (a reply only
    the dashboard read from Gmail: the mail agent has not seen it, so its follow-ups are not stopped)."""
    inbox = await inbox_ready()
    rows = await _rows(
        f"""select l.id, l.number, l.name, l.company, l.source, l.status,
                   r.id as reply_id, r.received_at as replied_at, r.label, r.review_note, r.body,
                   r.reply_source, r.match_method, r.we_replied_at, r.original_label, r.labelled_at,
                   a.answered_at, a.answer_queued
            from ({_leads_sql(inbox)}) l
            join ({_LATEST_HUMAN_REPLY_INBOX if inbox else _LATEST_HUMAN_REPLY}) r on r.contact_id = l.id
            left join lateral (
              select min(e.sent_at) filter (where e.status = 'sent') as answered_at,
                     coalesce(bool_or(e.status in ('approved', 'sending')), false) as answer_queued
              from emails e where e.reply_id = r.id
            ) a on true"""  # noqa: S608
    )
    # Replies not classified yet, and since when: the agent classifies them while it runs, so an old one means it is
    # stopped or stuck.
    pending = (await _rows("select count(*) as pending, min(received_at) as since from replies where label is null"))[0]
    # Same count as the dashboard's Responses: every lead with a reply written by a person, classified or not.
    replied = await _value(f"select count(*) from ({_leads_sql(inbox)}) l where status = 'Responded'")  # noqa: S608
    groups: dict[str, list[dict]] = {"positive": [], "review": [], "questions": [], "notInterested": [],
                                     "unsubscribe": []}
    for r in rows:
        body = r.pop("body")
        labelled = r.pop("labelledAt") is not None
        group, r["reviewReason"] = _judge(r["label"], r.pop("reviewNote"), r["replySource"], r["matchMethod"],
                                          labelled, body)
        r["preview"] = _preview(body)
        r["labelledByPerson"] = labelled
        queued = r.pop("answerQueued")
        we_replied = r.pop("weRepliedAt")
        if r["replySource"] == "inbox":
            # Only Gmail shows whether we answered: a later message of ours in the same conversation.
            r["answeredAt"] = we_replied
            r["followUp"] = "replied" if we_replied else "unknown"
        else:
            # A confident "no" closes the lead: nothing is waiting on us unless someone chose to answer anyway.
            closed = group == "notInterested" or (group == "unsubscribe" and r["label"] == "unsubscribe")
            r["followUp"] = "replied" if r["answeredAt"] else "queued" if queued else "none" if closed else "waiting"
        if group:
            groups[group].append(r)
    return {
        **{k: _follow_up_order(v) for k, v in groups.items()},
        "repliedLeads": replied or 0,
        "pending": pending["pending"] or 0,
        "pendingSince": pending["since"],
    }


# Same rules as the reply classifier's strip_quoted (agent/replies.py): keep only what the person wrote.
_QUOTE_START = re.compile(r"^(on .{5,120} wrote:|-{2,}\s*original message|from: .+@)", re.IGNORECASE)
_GREETING = re.compile(r"^(hi|hello|hey|dear|good (morning|afternoon|evening))\b.{0,40}$", re.IGNORECASE)


def _strip_quoted(body: str | None) -> str:
    kept: list[str] = []
    for line in (body or "").splitlines():
        if _QUOTE_START.match(line.strip()):
            break
        if not line.lstrip().startswith(">"):
            kept.append(line)
    return "\n".join(kept).strip()


def _preview(body: str | None, limit: int = 100) -> str:
    """What the person wrote, without quoted mail or the greeting line, on one line."""
    parts = [p.strip() for p in _strip_quoted(body).split("\n\n") if p.strip()]
    if len(parts) > 1 and _GREETING.match(parts[0]):
        parts = parts[1:]
    text = " ".join(" ".join(parts).split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


@router.get("/leads/{lead_id}")
async def lead(lead_id: str) -> dict:
    try:
        row = await _one(f"select * from ({await _leads()}) l where id = $1::uuid", lead_id)  # noqa: S608
    except asyncpg.DataError as exc:
        raise HTTPException(404, "Not found") from exc
    reply = await (await _pg()).fetchrow(
        "select id, email_id, label, review_note, received_at, body, reply_source, match_method, original_label, "  # noqa: S608
        f"labelled_by, labelled_at from ({await _latest_reply()}) r where contact_id = $1::uuid",
        lead_id,
    )
    email = await (await _pg()).fetchrow(
        "select id from emails where contact_id = $1::uuid and sent_at is not null "
        "order by sent_at desc limit 1",
        lead_id,
    )
    # The reply opens in History (it lists the replies the dashboard read from Gmail too); with no reply, the email sent.
    row["conversation"] = (
        {"type": "reply", "id": str(reply["id"])}
        if reply
        else {"type": "sent", "id": str(email["id"])}
        if email
        else None
    )
    row["replyLabel"] = reply["label"] if reply else None
    group, row["reviewReason"] = (
        _judge(reply["label"], reply["review_note"], reply["reply_source"], reply["match_method"],
               reply["labelled_at"] is not None, reply["body"])
        if reply else (None, None)
    )
    row["replyGroup"] = group
    row["replySource"] = reply["reply_source"] if reply else None
    # The agent's own label, kept when a person chose another one.
    row["originalLabel"] = reply["original_label"] if reply else None
    row["labelledBy"] = (
        {"by": reply["labelled_by"], "at": reply["labelled_at"].isoformat()} if reply and reply["labelled_at"] else None
    )
    # The reply the lead is judged on: what the person wrote (quoted earlier mail left out; the full thread is in
    # History). Falls back to the whole body when everything in it looks quoted.
    row["latestReply"] = (
        {"id": str(reply["id"]), "receivedAt": reply["received_at"].isoformat(),
         "text": _strip_quoted(reply["body"]) or (reply["body"] or "").strip()}
        if reply else None
    )
    return row


# ---------- Emails ----------

# Search text: matched case-insensitively anywhere in the listed columns (strpos, so % and _ are plain characters).
Search = Annotated[str | None, Query(max_length=100)]
SentStatus = Annotated[str | None, Query(pattern="^(sent|failed)$")]
# A reply's label from the classifier, 'unclassified' (not labelled yet), or 'human' (anything but the automatic
# out-of-office and bounce messages).
ReplyLabel = Annotated[
    str | None, Query(pattern="^(interested|question|not_interested|unsubscribe|ooo|bounce|unclassified|human)$")
]


def _search(columns: tuple[str, ...], q: str | None, conds: list[str], args: list) -> None:
    """Adds 'q appears in one of `columns`' to conds/args (nothing for an empty q). Columns are constants."""
    q = (q or "").strip()
    if q:
        args.append(q.lower())
        n = len(args)
        conds.append("(" + " or ".join(f"strpos(lower(coalesce({c}, '')), ${n}) > 0" for c in columns) + ")")


def _where(conds: list[str]) -> str:
    return f"where {' and '.join(conds)}" if conds else ""


@router.get("/emails/sent")
async def sent_emails(
    q: Search = None, status: SentStatus = None, page: PageNo = 1, limit: Limit = PAGE_SIZE
) -> dict:
    """One page of sent emails (newest first), searchable by recipient, company and subject, plus `failed`: how many
    of all sent emails bounced."""
    conds, args = [], []
    _search(('"to"', "company", "subject"), q, conds, args)
    if status:
        args.append("Failed" if status == "failed" else "Sent")
        conds.append(f"delivery_status = ${len(args)}")
    sent = await _sent()
    out = await _page(sent, "sent_at desc, id", page, limit, _where(conds), tuple(args))
    out["failed"] = await _value(f"select count(*) from ({sent}) s where delivery_status = 'Failed'") or 0  # noqa: S608
    return out


@router.get("/emails/sent/{email_id}")
async def sent_email(email_id: str) -> dict:
    try:
        row = await _one(f"select * from ({await _sent()}) s where id = $1::uuid", email_id)  # noqa: S608
        row["body"] = (await _one("select body from emails where id = $1::uuid", email_id))["body"]
    except asyncpg.DataError as exc:
        raise HTTPException(404, "Not found") from exc
    return row


@router.get("/emails/replies")
async def replies(q: Search = None, label: ReplyLabel = None, page: PageNo = 1, limit: Limit = PAGE_SIZE) -> dict:
    """One page of replies (newest first), searchable by sender, company and subject, filtered by label."""
    conds, args = [], []
    _search(("sender_name", "sender_email", "company", "subject"), q, conds, args)
    if label == "unclassified":
        conds.append("label is null")
    elif label == "human":
        conds.append("coalesce(label, '') not in ('ooo', 'bounce')")
    elif label:
        args.append(label)
        conds.append(f"label = ${len(args)}")
    out = await _page(await _replies(), "received_at desc, id", page, limit, _where(conds), tuple(args))
    out["items"] = [_without(r, "body") for r in out["items"]]
    return out


@router.get("/emails/replies/{reply_id}")
async def reply(reply_id: str) -> dict:
    try:
        row = await _one(f"select * from ({await _replies()}) r where id = $1::uuid", reply_id)  # noqa: S608
    except asyncpg.DataError as exc:
        raise HTTPException(404, "Not found") from exc
    orig = None
    if row["inReplyToId"]:
        orig = (await _rows(f"select * from ({await _sent()}) s where id = $1::uuid", row["inReplyToId"]))[  # noqa: S608
            :1
        ]
    row["originalEmail"] = (
        {k: orig[0][k] for k in ("id", "number", "to", "subject")} if orig else None
    )
    return row


# ---------- Blogs ----------


@router.get("/blogs")
async def blogs(page: PageNo = 1, limit: Limit = PAGE_SIZE) -> dict:
    """One page of posts (no content) plus `posted`: how many of all posts are published."""
    out = await _page(_BLOGS, "number desc", page, limit)
    out["items"] = [_without(r, "content") for r in out["items"]]
    out["posted"] = await _value(f"select count(*) from ({_BLOGS}) b where status = 'Posted'") or 0  # noqa: S608
    return out


@router.get("/blogs/{blog_id}")
async def blog(blog_id: str) -> dict:
    try:
        return await _one(f"select * from ({_BLOGS}) b where id = $1::uuid", blog_id)  # noqa: S608
    except asyncpg.DataError as exc:
        raise HTTPException(404, "Not found") from exc
