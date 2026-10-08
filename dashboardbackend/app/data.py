"""Read-only data routes for the dashboard.

Reads the tables the lead / outreach / content services write to (supabase/migrations/0002_core.sql)
and returns the same shapes the dashboard's mock data used (eval/dashboard/core/data.js), so the
frontend only has to swap its mock bodies for apiFetch() calls. Every route requires a Supabase login.
"""

import os
import re
import uuid
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import current_user

router = APIRouter(dependencies=[Depends(current_user)])

_pool: asyncpg.Pool | None = None

# Contacts get a stable 1-based number (oldest first) so the UI can show "#12".
_LEADS = """
select c.id, row_number() over (order by c.collected_at, c.id) as number,
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
                                            and coalesce(r.label, '') not in ('ooo', 'bounce'))
              then 'Responded'
            when exists (select 1 from emails e where e.contact_id = c.id and e.status = 'bounced')
              or exists (select 1 from replies r where r.contact_id = c.id and r.label = 'bounce')
              then 'Bounced'
            when exists (select 1 from emails e where e.contact_id = c.id
                                                and e.status = 'sent' and e.sent_at is not null)
              then 'Sent'
            else 'Not Sent' end as status,
       c.collected_at as added_at, c.last_engaged_at as last_contact_at
from contacts c join companies co on co.id = c.company_id
"""

_SENT = """
select * from (
  select e.id, row_number() over (order by e.sent_at, e.id) as number, e.contact_id as lead_id,
         e.mailbox as "from", c.email as "to", e.subject, e.sent_at,
         case e.status when 'sent' then 'Delivered' when 'bounced' then 'Failed' else 'Sent' end
           as delivery_status,
         (select r.id from replies r where r.email_id = e.id order by r.received_at limit 1) as reply_id
  from emails e join contacts c on c.id = e.contact_id
  where e.status in ('sent', 'bounced') and e.sent_at is not null
) s
"""

_REPLIES = """
select * from (
  select r.id, row_number() over (order by r.received_at, r.id) as number,
         coalesce(c.name, c.email) as sender_name, c.email as sender_email, e.mailbox as "to",
         'Re: ' || coalesce(e.subject, '') as subject, r.received_at, r.email_id as in_reply_to_id,
         r.label, r.body
  from replies r
  left join contacts c on c.id = r.contact_id
  left join emails e on e.id = r.email_id
) s
"""

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
Status = Annotated[str | None, Query(pattern="^(not_sent|sent|bounced|responded)$")]
_STATUS = {"not_sent": "Not Sent", "sent": "Sent", "bounced": "Bounced", "responded": "Responded"}
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
    out = await _page(_LEADS, "number desc", page, limit, where, tuple(args))
    hidden = ("title", "companyUrl", "profileUrl", "lastContactAt", "about")
    out["items"] = [_without(r, *hidden) for r in out["items"]]
    return out


@router.get("/leads/stats")
async def lead_stats() -> dict:
    rows = await _rows(f"select source, status, count(*) as n from ({_LEADS}) l group by 1, 2")  # noqa: S608
    by_source: dict[str, int] = {}
    for r in rows:
        by_source[r["source"]] = by_source.get(r["source"], 0) + r["n"]
    def count(status: str) -> int:
        return sum(r["n"] for r in rows if r["status"] == status)

    return {
        "total": sum(r["n"] for r in rows),
        "notSent": count("Not Sent"),
        "awaiting": count("Sent"),  # emailed, no reply yet
        "responded": count("Responded"),
        "bounced": count("Bounced"),
        "bySource": dict(sorted(by_source.items(), key=lambda kv: (-kv[1], kv[0]))),  # most leads first
    }


# Each lead's latest classified reply written by a person (out-of-office and bounces are automatic, so skipped).
# A lead is judged on this reply only, so a later "no" replaces an earlier "yes".
_LATEST_HUMAN_REPLY = """
select distinct on (r.contact_id) r.contact_id, r.id, r.received_at, r.label, r.review_note, r.body
from replies r
where r.label is not null and r.label not in ('ooo', 'bounce')
order by r.contact_id, r.received_at desc
"""

# The reply classifier records "confidence 0.42 < 0.6" in review_note when it isn't sure of the label.
_LOW_CONFIDENCE = re.compile(r"confidence\s+([\d.]+)\s*<", re.IGNORECASE)


def _review_reason(note: str | None) -> str | None:
    m = _LOW_CONFIDENCE.search(note or "")
    return f"Low confidence ({float(m.group(1)):.2f})" if m else None


# Labels whose low-confidence replies go to "Needs review" (a doubtful "no" may be a hidden "yes").
_REVIEWABLE = ("interested", "question", "not_interested")


def _follow_up_order(items: list[dict]) -> list[dict]:
    """Leads still waiting for our answer first, longest-waiting at the top; then the rest, newest reply first."""
    waiting = sorted((r for r in items if r["followUp"] == "waiting"), key=lambda r: r["repliedAt"])
    rest = sorted((r for r in items if r["followUp"] != "waiting"), key=lambda r: r["repliedAt"], reverse=True)
    return waiting + rest


@router.get("/leads/positive")
async def positive_leads() -> dict:
    """Leads judged on their latest human reply, split into positive (interested, confident),
    review (low confidence) and questions. followUp says whether we have answered that reply:
    'replied' (sent), 'queued' (approved, not sent yet) or 'waiting'."""
    rows = await _rows(
        f"""select l.id, l.number, l.name, l.company, l.source, l.status,
                   r.id as reply_id, r.received_at as replied_at, r.label, r.review_note, r.body,
                   a.answered_at, a.answer_queued
            from ({_LEADS}) l
            join ({_LATEST_HUMAN_REPLY}) r on r.contact_id = l.id
            left join lateral (
              select min(e.sent_at) filter (where e.status = 'sent') as answered_at,
                     coalesce(bool_or(e.status in ('approved', 'sending')), false) as answer_queued
              from emails e where e.reply_id = r.id
            ) a on true"""  # noqa: S608
    )
    pending = await _value("select count(*) from replies where label is null")  # not classified yet
    groups: dict[str, list[dict]] = {"positive": [], "review": [], "questions": []}
    for r in rows:
        r["preview"] = _preview(r.pop("body"))
        r["reviewReason"] = _review_reason(r.pop("reviewNote"))
        queued = r.pop("answerQueued")
        r["followUp"] = "replied" if r["answeredAt"] else "queued" if queued else "waiting"
        if r["reviewReason"] and r["label"] in _REVIEWABLE:
            groups["review"].append(r)
        elif r["label"] == "interested":
            groups["positive"].append(r)
        elif r["label"] == "question":
            groups["questions"].append(r)
    return {
        **{k: _follow_up_order(v) for k, v in groups.items()},
        "repliedLeads": len(rows),
        "pending": pending or 0,
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
        row = await _one(f"select * from ({_LEADS}) l where id = $1::uuid", lead_id)  # noqa: S608
    except asyncpg.DataError as exc:
        raise HTTPException(404, "Not found") from exc
    reply = await (await _pg()).fetchrow(
        f"select id, label, review_note from ({_LATEST_HUMAN_REPLY}) r where contact_id = $1::uuid",  # noqa: S608
        lead_id,
    )
    email = await (await _pg()).fetchrow(
        "select id from emails where contact_id = $1::uuid and sent_at is not null "
        "order by sent_at desc limit 1",
        lead_id,
    )
    row["conversation"] = (
        {"type": "reply", "id": str(reply["id"])}
        if reply
        else {"type": "sent", "id": str(email["id"])}
        if email
        else None
    )
    row["replyLabel"] = reply["label"] if reply else None
    row["reviewReason"] = _review_reason(reply["review_note"]) if reply else None
    row["notes"] = None
    return row


# ---------- Emails ----------


@router.get("/emails/sent")
async def sent_emails(page: PageNo = 1, limit: Limit = PAGE_SIZE) -> dict:
    return await _page(_SENT, "sent_at desc, id", page, limit)


@router.get("/emails/sent/{email_id}")
async def sent_email(email_id: str) -> dict:
    try:
        row = await _one(f"select * from ({_SENT}) s where id = $1::uuid", email_id)  # noqa: S608
        row["body"] = (await _one("select body from emails where id = $1::uuid", email_id))["body"]
    except asyncpg.DataError as exc:
        raise HTTPException(404, "Not found") from exc
    return row


@router.get("/emails/replies")
async def replies(page: PageNo = 1, limit: Limit = PAGE_SIZE) -> dict:
    out = await _page(_REPLIES, "received_at desc, id", page, limit)
    out["items"] = [_without(r, "body") for r in out["items"]]
    return out


@router.get("/emails/replies/{reply_id}")
async def reply(reply_id: str) -> dict:
    try:
        row = await _one(f"select * from ({_REPLIES}) r where id = $1::uuid", reply_id)  # noqa: S608
    except asyncpg.DataError as exc:
        raise HTTPException(404, "Not found") from exc
    orig = None
    if row["inReplyToId"]:
        orig = (await _rows(f"select * from ({_SENT}) s where id = $1::uuid", row["inReplyToId"]))[  # noqa: S608
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
