"""Read-only data routes for the dashboard.

Reads the tables the lead / outreach / content services write to (supabase/migrations/0002_core.sql)
and returns the same shapes the dashboard's mock data used (eval/dashboard/core/data.js), so the
frontend only has to swap its mock bodies for apiFetch() calls. Every route requires a Supabase login.
"""

import os
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
       case when lower(coalesce(co.source, '')) like '%linkedin%' then 'linkedin'
            when lower(coalesce(co.source, '')) ~ '(^|[^a-z])(x|twitter)([^a-z]|$)' then 'x'
            else 'other' end as source,
       case when exists (select 1 from replies r where r.contact_id = c.id)
            then 'Responded' else 'Awaiting' end as status,
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


def _plain(row: asyncpg.Record) -> dict:
    """Record -> JSON-ready camelCase dict (uuids and datetimes become strings)."""
    out = {}
    for key, val in dict(row).items():
        head, *rest = key.split("_")
        out[head + "".join(w.title() for w in rest)] = (
            val.isoformat() if hasattr(val, "isoformat") else str(val) if hasattr(val, "hex") else val
        )
    return out


def _without(d: dict, *keys: str) -> dict:
    return {k: v for k, v in d.items() if k not in keys}


Source = Annotated[str | None, Query(pattern="^(linkedin|x|other)$")]
Status = Annotated[str | None, Query(pattern="^(awaiting|responded)$")]

# ---------- Leads ----------


@router.get("/leads")
async def leads(status: Status = None, source: Source = None) -> list[dict]:
    rows = await _rows(f"select * from ({_LEADS}) l order by number desc")  # noqa: S608
    return [
        _without(r, "title", "company", "companyUrl", "profileUrl", "email", "lastContactAt")
        for r in rows
        if (not status or r["status"].lower() == status) and (not source or r["source"] == source)
    ]


@router.get("/leads/stats")
async def lead_stats() -> dict:
    rows = await _rows(f"select source, status from ({_LEADS}) l")  # noqa: S608
    by_source = {"linkedin": 0, "x": 0, "other": 0}
    for r in rows:
        by_source[r["source"]] += 1
    awaiting = sum(r["status"] == "Awaiting" for r in rows)
    return {
        "total": len(rows),
        "awaiting": awaiting,
        "responded": len(rows) - awaiting,
        "bySource": by_source,
    }


@router.get("/leads/positive")
async def positive_leads() -> list[dict]:
    rows = await _rows(
        f"""select l.id, l.number, l.name, l.company, l.source, l.status,
                   r.id as reply_id, r.received_at as replied_at, r.label, r.body
            from replies r join ({_LEADS}) l on l.id = r.contact_id
            where r.label = 'interested' order by r.received_at desc"""  # noqa: S608
    )
    for r in rows:
        text = _reply_text(r.pop("body"))
        r["preview"] = text if len(text) <= 100 else text[:99].rstrip() + "…"
    return rows


def _reply_text(body: str | None) -> str:
    """First paragraph after the greeting; falls back to the whole body."""
    parts = [p.strip() for p in (body or "").split("\n\n") if p.strip()]
    return parts[1] if len(parts) > 1 else (parts[0] if parts else "")


@router.get("/leads/{lead_id}")
async def lead(lead_id: str) -> dict:
    try:
        row = await _one(f"select * from ({_LEADS}) l where id = $1::uuid", lead_id)  # noqa: S608
    except asyncpg.DataError as exc:
        raise HTTPException(404, "Not found") from exc
    reply = await (await _pg()).fetchrow(
        "select id, label from replies where contact_id = $1::uuid order by received_at desc limit 1",
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
    row["notes"] = None
    return row


# ---------- Emails ----------


@router.get("/emails/sent")
async def sent_emails() -> list[dict]:
    return await _rows(f"select * from ({_SENT}) s order by sent_at desc")  # noqa: S608


@router.get("/emails/sent/{email_id}")
async def sent_email(email_id: str) -> dict:
    try:
        row = await _one(f"select * from ({_SENT}) s where id = $1::uuid", email_id)  # noqa: S608
        row["body"] = (await _one("select body from emails where id = $1::uuid", email_id))["body"]
    except asyncpg.DataError as exc:
        raise HTTPException(404, "Not found") from exc
    return row


@router.get("/emails/replies")
async def replies() -> list[dict]:
    rows = await _rows(f"select * from ({_REPLIES}) r order by received_at desc")  # noqa: S608
    return [_without(r, "body") for r in rows]


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
async def blogs() -> list[dict]:
    rows = await _rows(f"select * from ({_BLOGS}) b order by number desc")  # noqa: S608
    return [_without(r, "content") for r in rows]


@router.get("/blogs/{blog_id}")
async def blog(blog_id: str) -> dict:
    try:
        return await _one(f"select * from ({_BLOGS}) b where id = $1::uuid", blog_id)  # noqa: S608
    except asyncpg.DataError as exc:
        raise HTTPException(404, "Not found") from exc
