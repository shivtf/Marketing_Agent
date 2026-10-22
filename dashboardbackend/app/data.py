"""Read-only data routes for the dashboard.

Reads the tables the Marketing Agent writes (companies, contacts, emails, content_posts; never writes them) and returns
them as camelCase JSON for dashboard/core/api.js. Every route requires a Supabase login.
The mail agent only sends: every reply is one this backend read from Gmail (app/inbox.py, table inbox_replies), with
the label a person gave it (reply_labels). Both tables come from migrations/007_inbox_replies.sql.
"""

import asyncio
import json
import logging
import os
import uuid
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import current_user
from app.reply_rules import (
    POSITIVE_AT,
    REVIEW_AT,
    RULES_VERSION,
    STRONG_NO,
    mentions_unsubscribe,
    score_reply,
    score_saved,
    strip_quoted,
)

log = logging.getLogger(__name__)
router = APIRouter(dependencies=[Depends(current_user)])

_pool: asyncpg.Pool | None = None
_pool_lock = asyncio.Lock()  # the dashboard sends several requests at once; they must share one pool
SCORES_MIGRATION = "Run migrations/013_reply_scores.sql in the Supabase SQL editor first."

# A lead is a contact of a company, or a company still in the pipeline that has no contact yet ('No Contact': qualified,
# or waiting for a person on Needs Contact). Companies the agent only discovered or rejected are not leads. Every lead
# gets a 1-based number (oldest first) so the UI can show "#12". A company's id is its own; a contact's is the contact's.
_LEADS = "select * from lead_my"


async def refresh_leads() -> None:
    """Rebuilds lead_my (migrations/015_leads_my.sql). Call it after anything that changes a lead's status. A failure
    only leaves the list a little stale, so it is logged, not raised."""
    try:
        await (await _pg()).execute("select public.dashboard_refresh_leads()")
    except Exception:  # noqa: BLE001 - the request is answered either way
        log.warning("Could not refresh lead_my", exc_info=True)

# delivery_status: 'Sent' means the agent sent it without an error (not proof it reached the inbox); 'Failed' = bounced,
# as the agent recorded it or as a bounce notice read from Gmail says (the same rule as the lead's Bounced status).
_SENT = """
select * from (
  select e.id, row_number() over (order by e.sent_at, e.id) as number, e.contact_id as lead_id, co.name as company,
         e.mailbox as "from", c.email as "to", e.subject, e.sent_at,
         case when e.status = 'bounced'
                     or exists (select 1 from inbox_replies b where b.email_id = e.id and b.auto_label = 'bounce')
              then 'Failed' else 'Sent' end as delivery_status,
         -- The reply to it: one read from Gmail that surely answers it (reply headers or the same conversation, not
         -- just the sender's address) and was written by a person (not a bounce notice or an out-of-office).
         (select s.id from inbox_replies s
          left join reply_labels hl on hl.source = 'inbox' and hl.reply_id = s.id
          where s.email_id = e.id and s.match_method in ('header', 'thread')
            and coalesce(hl.label, s.auto_label, '') not in ('ooo', 'bounce')
          order by s.received_at limit 1) as reply_id
  from emails e join contacts c on c.id = e.contact_id
  left join companies co on co.id = c.company_id
  where e.status in ('sent', 'bounced') and e.sent_at is not null
) s
"""

_FAILED_COUNT = """
select count(*) from emails e
where e.status in ('sent', 'bounced') and e.sent_at is not null
and (e.status = 'bounced' or exists (select 1 from inbox_replies b where b.email_id = e.id and b.auto_label = 'bounce'))
"""

# Replies read from Gmail, with a person's label in place of the automatic one (out-of-office / bounce), numbered
# oldest first so "#12" stays put.
_REPLIES = """
select *, row_number() over (order by received_at, id) as number from (
  -- Who wrote it: the lead, or someone else in the conversation (e.g. a colleague they copied in).
  select s.id,
         case when lower(c.email) = s.from_email then coalesce(c.name, c.email) else s.from_email end as sender_name,
         s.from_email as sender_email,
         e.mailbox as "to", coalesce(s.subject, 'Re: ' || coalesce(e.subject, '')) as subject, s.received_at,
         s.email_id as in_reply_to_id, coalesce(hl.label, s.auto_label) as label, s.body, s.contact_id as lead_id,
         co.name as company
  from inbox_replies s
  left join contacts c on c.id = s.contact_id
  left join companies co on co.id = c.company_id
  left join emails e on e.id = s.email_id
  left join reply_labels hl on hl.source = 'inbox' and hl.reply_id = s.id
) u
"""

_BLOGS_SQL = """
select s.*, row_number() over (order by s.added_at, s.id) as number from (
  select p.id, p.created_at as added_at, p.title,
         case when p.status = 'published' then 'Posted' else 'Not Posted' end as status,
         case when p.devto_url is not null then 'Dev.to'
              when p.cms_url is not null then 'WordPress'
              when p.linkedin_url is not null then 'LinkedIn' end as site,
         coalesce(p.cms_url, p.devto_url, p.linkedin_url) as url,
         p.published_at as posted_at, {p_body} as content
  from content_posts p
  -- The ones this backend posts (app/blog_posts.py, migrations/011_blog_posts.sql); the Marketing Agent posted the
  -- ones above. A Dev.to draft, a failed or an unfinished post is Not Posted.
  union all
  select b.id, b.started_at, b.title,
         case when b.status = 'posted' and not b.draft then 'Posted' else 'Not Posted' end,
         'Dev.to', b.url, b.posted_at, {b_body}
  from blog_posts b
) s
"""

_BLOGS = _BLOGS_SQL.format(p_body="p.body_md", b_body="b.body_md")
_BLOGS_LIST = _BLOGS_SQL.format(p_body="null::text", b_body="null::text")

_POSTED_COUNT = """
select (select count(*) from content_posts where status = 'published')
+ (select count(*) from blog_posts where status = 'posted' and not draft)
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
    n = len(args)
    rows = await _rows(
        f"select p.*, count(*) over () as total_rows from ({sql} order by {order}) p limit ${n + 1} offset ${n + 2}",  # noqa: S608
        *args,
        limit,
        (page - 1) * limit,
    )
    if rows:
        total = rows[0]["totalRows"]
    elif page == 1:
        total = 0
    else:  # past the last page: no row carries the total, so count
        total = await _value(f"select count(*) from ({sql}) c", *args)  # noqa: S608
    for r in rows:
        r.pop("totalRows")
    return {"items": rows, "total": total or 0, "page": page, "limit": limit}

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
        "noContact": count("No Contact"),  # in the pipeline, no contact to email yet (see Needs Contact)
        "awaiting": count("Sent"),  # emailed, no reply yet
        "responded": count("Responded"),
        "bounced": count("Bounced"),
        "bySource": dict(sorted(by_source.items(), key=lambda kv: (-kv[1], kv[0]))),  # most leads first
    }


# Every reply of a lead, with a person's label if one was given (else the automatic out-of-office / bounce one).
_LEAD_REPLIES = """
select s.contact_id, s.id, s.email_id, s.received_at, coalesce(hl.label, s.auto_label) as label,
       s.body, e.body as sent_body, s.we_replied_at, hl.labelled_by, hl.labelled_at, s.score_data, s.scored_with
from inbox_replies s
left join reply_labels hl on hl.source = 'inbox' and hl.reply_id = s.id
left join emails e on e.id = s.email_id
where s.contact_id is not null
"""
# The ones written by a person (out-of-office and bounces are automatic, so skipped). Positive Leads lists each of them
# on its own: a lead's new email adds a row, its older ones stay.
_HUMAN_REPLIES = f"select * from ({_LEAD_REPLIES}) r where coalesce(label, '') not in ('ooo', 'bounce')"  # noqa: S608
# Each lead's latest one (the lead drawer opened from the Dashboard shows it).
_LATEST_HUMAN_REPLY = f"select distinct on (contact_id) * from ({_HUMAN_REPLIES}) h order by contact_id, received_at desc"  # noqa: S608


def _judge(label: str | None, labelled: bool, text: str) -> tuple[str | None, str | None, dict]:
    """Where a reply goes on Positive Leads -> (group, why it needs review, its keyword score). text is
    what the person wrote (quoted mail removed). See _group."""
    scored = score_reply(text)
    return (*_group(label, labelled, scored, mentions_unsubscribe(text)), scored)


def _group(label: str | None, labelled: bool, scored: dict, seems_unsubscribe: bool) -> tuple[str | None, str | None]:
    """Where a reply goes on Positive Leads, from its label and its keyword score (score_reply(), or the saved one)
    -> (group, why it needs review). group is positive / review / questions / notInterested / unsubscribe, or None (not
    listed). A person's label is trusted as given. Cheap, so it runs on every load: labels change, scores don't.
    Lopsided on purpose: only a clear no (a strong no, or soft nos scoring below REVIEW_AT) closes a reply as
    notInterested; a reply with only a soft no goes to a person (review). Asking to be contacted later, pointing to
    someone else or asking a question keeps a reply open (review / questions) unless it has a strong no."""
    if label in ("ooo", "bounce"):  # automatic, not a person's answer: not listed
        return None, None
    if label == "unsubscribe":
        return "unsubscribe", None
    if labelled:
        return {"interested": "positive", "question": "questions", "not_interested": "notInterested"}.get(label), None
    if seems_unsubscribe:
        # Safety net: a reply that seems to ask to stop is never shown as an ordinary lead. Only what the person wrote
        # is read: our own quoted email (and its unsubscribe footer) is left out.
        return "unsubscribe", "It seems to ask not to be contacted again"
    score, hits = scored["score"], scored["hits"]
    yes, no = any(h["weight"] > 0 for h in hits), any(h["weight"] < 0 for h in hits)
    clear_no = any(h["weight"] <= STRONG_NO for h in hits)
    if yes and no:
        return "review", f"Score {score:.2f}: says both yes and no"
    if score >= POSITIVE_AT:
        return "positive", None
    if scored["referral"] and not clear_no:
        return "review", "Points you to someone else: write to them"
    if scored["later"] and not clear_no:
        return "review", "Asks to be contacted later"
    if scored["question"] and not clear_no:  # a soft no with a question ("Too busy now. Next month?") still asks
        return "questions", None
    if score < REVIEW_AT:
        return "notInterested", None
    if no:
        return "review", f"Score {score:.2f}: only a soft no (it may mean later)"
    return "review", f"Score {score:.2f}: no clear yes or no" if hits else "No keywords matched"


def _saved_score(data: Any, version: int | None) -> dict | None:
    """A reply's saved score (inbox_replies.score_data), or None when it has none or was scored with older rules."""
    if data is None or version != RULES_VERSION:
        return None
    return json.loads(data) if isinstance(data, str) else data  # asyncpg hands jsonb over as text


async def _save_scores(scores: list[tuple[str, dict]]) -> None:
    """Saves the scores just worked out ([(reply id, score_saved())]) in one statement, so they are never worked out
    again. Best effort: a failure only means they are worked out again on the next load."""
    if not scores:
        return
    try:
        await (await _pg()).execute(
            "update inbox_replies s set score_data = u.d::jsonb, scored_with = $3"
            " from unnest($1::uuid[], $2::text[]) u(id, d) where s.id = u.id",
            [i for i, _ in scores], [json.dumps(d) for _, d in scores], RULES_VERSION,
        )
    except Exception:  # noqa: BLE001 - the page is answered either way
        log.warning("Could not save %d reply scores; they are worked out again next time", len(scores), exc_info=True)


def _follow_up_order(items: list[dict]) -> list[dict]:
    """Leads still waiting for our answer first, longest-waiting at the top; then the rest, newest reply first."""
    waiting = sorted((r for r in items if r["followUp"] == "waiting"), key=lambda r: r["repliedAt"])
    rest = sorted((r for r in items if r["followUp"] != "waiting"), key=lambda r: r["repliedAt"], reverse=True)
    return waiting + rest


@router.get("/leads/positive")
async def positive_leads() -> dict:
    """Every reply written by a person, each on its own row (id = the reply, leadId = its lead), split into positive,
    review, questions, notInterested and unsubscribe (asked to stop, or seems to) by a person's label or else the keyword
    score (_judge). A lead's new email adds a row; its older ones stay where they are. score / scoreHits: the keyword
    score and the phrases behind it. followUp says whether we have answered that reply: 'replied' (a later message of
    ours in the Gmail conversation), 'none' (a "no" that needs no answer), 'later' (the lead wrote again since: their
    newer email is the one waiting) or 'waiting'."""
    # The saved score is used as is; the texts are fetched only for a reply that has none yet (or older rules).
    try:
        rows = await _rows(
            f"""select r.id, l.id as lead_id, l.number, l.name, l.company, l.source, l.status,
                       r.id as reply_id, r.received_at as replied_at, r.we_replied_at as answered_at, r.label,
                       r.labelled_at, r.score_data, r.scored_with,
                       case when r.scored_with = $1 then null else r.body end as body,
                       case when r.scored_with = $1 then null else r.sent_body end as sent_body
                from ({_LEADS}) l
                join ({_HUMAN_REPLIES}) r on r.contact_id = l.id""",  # noqa: S608
            RULES_VERSION,
        )
        # Same count as the dashboard's Responses: every lead with a reply written by a person, labelled or not.
        replied = len({r["leadId"] for r in rows})
    except asyncpg.UndefinedColumnError as exc:
        raise HTTPException(503, SCORES_MIGRATION) from exc
    groups: dict[str, list[dict]] = {"positive": [], "review": [], "questions": [], "notInterested": [],
                                     "unsubscribe": []}
    latest: dict[str, str] = {}  # lead -> when they last wrote
    for r in rows:
        latest[r["leadId"]] = max(latest.get(r["leadId"], r["repliedAt"]), r["repliedAt"])
    fresh: list[tuple[str, dict]] = []  # scored on this load: saved below
    for r in rows:
        body, ours = r.pop("body"), r.pop("sentBody")
        scored = _saved_score(r.pop("scoreData"), r.pop("scoredWith"))
        if scored is None:
            scored = score_saved(body, ours)
            fresh.append((r["id"], scored))
        labelled = r.pop("labelledAt") is not None
        group, r["reviewReason"] = _group(r["label"], labelled, scored, scored["unsubscribe"])
        r["score"], r["scoreHits"] = scored["score"], scored["hits"]
        r["preview"] = scored["preview"]
        r["labelledByPerson"] = labelled
        # A "no" closes the lead: nothing is waiting on us unless someone chose to answer anyway.
        closed = group == "notInterested" or (group == "unsubscribe" and r["label"] == "unsubscribe")
        r["followUp"] = ("replied" if r["answeredAt"] else "none" if closed
                         else "later" if r["repliedAt"] < latest[r["leadId"]] else "waiting")
        if group:
            groups[group].append(r)
    await _save_scores(fresh)
    return {**{k: _follow_up_order(v) for k, v in groups.items()}, "repliedLeads": replied or 0}


@router.get("/leads/by-reply/{reply_id}")
async def lead_by_reply(reply_id: str) -> dict:
    """A lead with one particular reply of theirs (Positive Leads lists each reply on its own). Out-of-office and bounce
    replies too: a reply a person has just labelled one of those stays open in the drawer, so the label can be taken
    back."""
    try:
        reply = await (await _pg()).fetchrow(
            "select contact_id, id, email_id, label, received_at, body, sent_body, labelled_by, labelled_at, "  # noqa: S608
            "score_data, scored_with "
            f"from ({_LEAD_REPLIES}) r where id = $1::uuid",
            reply_id,
        )
    except asyncpg.DataError as exc:
        raise HTTPException(404, "Not found") from exc
    except asyncpg.UndefinedColumnError as exc:
        raise HTTPException(503, SCORES_MIGRATION) from exc
    if reply is None:
        raise HTTPException(404, "Not found")
    return await _lead_detail(str(reply["contact_id"]), reply)


@router.get("/leads/{lead_id}")
async def lead(lead_id: str) -> dict:
    try:
        reply = await (await _pg()).fetchrow(
            "select id, email_id, label, received_at, body, sent_body, labelled_by, labelled_at, score_data, "  # noqa: S608
            "scored_with "
            f"from ({_LATEST_HUMAN_REPLY}) r where contact_id = $1::uuid",
            lead_id,
        )
    except asyncpg.DataError as exc:
        raise HTTPException(404, "Not found") from exc
    except asyncpg.UndefinedColumnError as exc:
        raise HTTPException(503, SCORES_MIGRATION) from exc
    return await _lead_detail(lead_id, reply)


async def _lead_detail(lead_id: str, reply: asyncpg.Record | None) -> dict:
    """The lead, judged on `reply` (None: they have not replied)."""
    try:
        row = await _one(f"select * from ({_LEADS}) l where id = $1::uuid", lead_id)  # noqa: S608
    except asyncpg.DataError as exc:
        raise HTTPException(404, "Not found") from exc
    email = await (await _pg()).fetchrow(
        "select id from emails where contact_id = $1::uuid and sent_at is not null "
        "order by sent_at desc limit 1",
        lead_id,
    )
    # The reply opens in the drawer; with no reply, the email sent.
    row["conversation"] = (
        {"type": "reply", "id": str(reply["id"])}
        if reply
        else {"type": "sent", "id": str(email["id"])}
        if email
        else None
    )
    row["replyLabel"] = reply["label"] if reply else None
    scored = None
    if reply:
        scored = _saved_score(reply["score_data"], reply["scored_with"])
        if scored is None:
            scored = score_saved(reply["body"], reply["sent_body"])
            await _save_scores([(str(reply["id"]), scored)])
    group, row["reviewReason"] = (
        _group(reply["label"], reply["labelled_at"] is not None, scored, scored["unsubscribe"]) if reply else (None, None)
    )
    row["replyGroup"] = group
    # An unsubscribe: is the lead on the mail agent's do-not-email list yet? None: unknown (migration 012 not run).
    row["doNotEmail"] = None
    if group == "unsubscribe" and row.get("email"):
        try:
            row["doNotEmail"] = await _value("select dashboard_is_suppressed($1)", row["email"])
        except asyncpg.UndefinedFunctionError:
            log.warning("migrations/012_unsubscribe_suppression.sql has not been run")
    row["score"] = scored["score"] if scored else None
    row["scoreHits"] = scored["hits"] if scored else []
    row["labelledBy"] = (
        {"by": reply["labelled_by"], "at": reply["labelled_at"].isoformat()} if reply and reply["labelled_at"] else None
    )
    # The reply shown: what the person wrote (quoted earlier mail left out; the full thread is in
    # History). Falls back to the whole body when everything in it looks quoted.
    row["latestReply"] = (
        {"id": str(reply["id"]), "receivedAt": reply["received_at"].isoformat(),
         "text": strip_quoted(reply["body"], reply["sent_body"]) or (reply["body"] or "").strip()}
        if reply else None
    )
    return row


# ---------- Emails ----------

# Search text: matched case-insensitively anywhere in the listed columns (strpos, so % and _ are plain characters).
Search = Annotated[str | None, Query(max_length=100)]
SentStatus = Annotated[str | None, Query(pattern="^(sent|failed)$")]


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
    out = await _page(_SENT, "sent_at desc, id", page, limit, _where(conds), tuple(args))
    out["failed"] = await _value(_FAILED_COUNT) or 0
    return out


@router.get("/emails/sent/{email_id}")
async def sent_email(email_id: str) -> dict:
    try:
        row = await _one(f"select * from ({_SENT}) s where id = $1::uuid", email_id)  # noqa: S608
        row["body"] = (await _one("select body from emails where id = $1::uuid", email_id))["body"]
    except asyncpg.DataError as exc:
        raise HTTPException(404, "Not found") from exc
    return row


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
    out = await _page(_BLOGS_LIST, "number desc", page, limit)
    out["items"] = [_without(r, "content") for r in out["items"]]
    out["posted"] = await _value(_POSTED_COUNT) or 0
    return out


@router.get("/blogs/{blog_id}")
async def blog(blog_id: str) -> dict:
    try:
        return await _one(f"select * from ({_BLOGS}) b where id = $1::uuid", blog_id)  # noqa: S608
    except asyncpg.DataError as exc:
        raise HTTPException(404, "Not found") from exc
