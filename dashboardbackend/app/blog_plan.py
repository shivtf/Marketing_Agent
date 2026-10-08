"""Blog plan: weekly blog briefs uploaded as JSON on the Blogs page (format and storage: BLOG_PLAN.md).

Each entry is a brief for one blog (topic, category, keywords, tone, length, target versions, reference links,
publish date), not the blog text. Briefs are stored in public.blog_plan (migrations/002_blog_plan.sql). The post
written from a brief links back through post_id; nothing writes or publishes posts automatically yet.
"""

import datetime as dt
import json
import re
from collections import Counter
from typing import Annotated, Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.auth import current_admin, current_user
from app.data import _pg, _plain

router = APIRouter(prefix="/blogs/plan")
User = Annotated[dict, Depends(current_user)]
Admin = Annotated[dict, Depends(current_admin)]

MAX_BYTES = 1_000_000
MAX_ENTRIES = 60
KNOWN_CATEGORIES = ("AOSP", "HAL", "BSP", "Embedded", "Kernel", "Drivers", "Security", "Tooling")
_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
_URL = re.compile(r"^https?://[^\s/$.?#][^\s]*$", re.IGNORECASE)

# Same as migrations/002_blog_plan.sql, so the upload works without running that file by hand.
_CREATE = """
create table if not exists public.blog_plan (
  id              uuid primary key default gen_random_uuid(),
  external_id     text not null unique,
  topic           text not null,
  category        text not null,
  keywords        text[] not null default '{}',
  publish_date    date not null,
  tone            text,
  length          text,
  target_versions text[] not null default '{}',
  reference_urls  text[] not null default '{}',
  status          text not null default 'planned'
                  check (status in ('planned', 'written', 'posted', 'cancelled')),
  post_id         uuid references public.content_posts (id) on delete set null,
  uploaded_by     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists blog_plan_publish_date_idx on public.blog_plan (publish_date);
alter table public.blog_plan enable row level security;
"""
_table_ready = False

# Each brief with the post written from it, if any.
_PLAN = """
select b.id, b.external_id, b.topic, b.category, b.keywords, b.publish_date, b.tone, b.length,
       b.target_versions, b.reference_urls, b.status as plan_status, b.uploaded_by, b.created_at, b.updated_at,
       b.post_id, p.status as post_status, coalesce(p.cms_url, p.devto_url, p.linkedin_url) as post_url
from public.blog_plan b
left join content_posts p on p.id = b.post_id
"""


def _today() -> dt.date:
    return dt.datetime.now(dt.UTC).date()


async def _db():
    global _table_ready
    pool = await _pg()
    if not _table_ready:
        await pool.execute(_CREATE)
        _table_ready = True
    return pool


# ---------- Validation ----------


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _str_list(value: Any) -> list[str] | None:
    """A list of non-empty strings, or None when it isn't one."""
    if not isinstance(value, list) or not all(isinstance(v, str) and v.strip() for v in value):
        return None
    return [v.strip() for v in value]


def validate(payload: Any, today: dt.date) -> tuple[list[dict], list[dict], list[dict]]:
    """-> (entries ready to save, errors, warnings). Errors and warnings are { id, field, message }; an entry with
    any error is left out of `entries`. Every problem is reported at once so the file can be fixed in one go."""
    errors: list[dict] = []
    warnings: list[dict] = []

    def err(eid: str, field: str, message: str) -> None:
        errors.append({"id": eid, "field": field, "message": message})

    blogs = payload.get("blogs") if isinstance(payload, dict) else None
    if not isinstance(blogs, list) or not blogs:
        err("", "blogs", 'The file needs a non-empty "blogs" list.')
        return [], errors, warnings
    if len(blogs) > MAX_ENTRIES:
        err("", "blogs", f"At most {MAX_ENTRIES} blogs per file (this one has {len(blogs)}).")
        return [], errors, warnings

    ids = Counter(_text(b.get("id")) for b in blogs if isinstance(b, dict))
    entries: list[dict] = []
    for n, b in enumerate(blogs, start=1):
        if not isinstance(b, dict):
            err(f"#{n}", "", "Each blog must be an object.")
            continue
        eid = _text(b.get("id")) or f"#{n}"
        before = len(errors)

        if not _text(b.get("id")):
            err(eid, "id", "Missing id.")
        elif not _ID.match(eid):
            err(eid, "id", "Use up to 40 letters, digits, - or _.")
        elif ids[eid] > 1:
            err(eid, "id", "This id is used more than once in the file.")

        topic = _text(b.get("topic"))
        if not 10 <= len(topic) <= 200:
            err(eid, "topic", "Topic is required, 10 to 200 characters." if topic else "Missing topic.")

        category = _text(b.get("category"))
        if not category:
            err(eid, "category", "Missing category.")
        elif category not in KNOWN_CATEGORIES:
            warnings.append({"id": eid, "field": "category", "message": f'"{category}" is not a usual category.'})

        keywords = _str_list(b.get("keywords"))
        if keywords is None or not 1 <= len(keywords) <= 10:
            err(eid, "keywords", "Give 1 to 10 keywords, each a non-empty text.")

        try:
            publish = dt.date.fromisoformat(_text(b.get("publish_date")))
            if publish < today:
                err(eid, "publish_date", f"{publish.isoformat()} is in the past.")
        except ValueError:
            publish = None
            err(eid, "publish_date", "Use a real date written as YYYY-MM-DD.")

        for field in ("tone", "length"):
            value = b.get(field)
            if value is not None and (not isinstance(value, str) or len(value) > 100):
                err(eid, field, f"{field.capitalize()} must be text, at most 100 characters.")

        versions = _str_list(b.get("target_versions", []))
        if versions is None:
            err(eid, "target_versions", "Target versions must be a list of texts.")

        urls = _str_list(b.get("reference_urls", []))
        if urls is None or len(urls) > 10 or not all(_URL.match(u) for u in urls):
            err(eid, "reference_urls", "Give at most 10 links, each starting with http:// or https://.")

        if len(errors) == before:
            entries.append({
                "external_id": eid, "topic": topic, "category": category, "keywords": keywords,
                "publish_date": publish, "tone": _text(b.get("tone")) or None,
                "length": _text(b.get("length")) or None, "target_versions": versions, "reference_urls": urls,
            })

    for day, n in Counter(e["publish_date"] for e in entries).items():
        if n > 1:
            warnings.append({"id": "", "field": "publish_date", "message": f"{n} blogs are planned for {day}."})
    return entries, errors, warnings


# ---------- Routes ----------


def _status(row: dict, today: dt.date) -> str:
    """planned | written | posted | missed | cancelled ('missed' is worked out here, never stored)."""
    if row["plan_status"] == "cancelled":
        return "cancelled"
    if row["post_status"] == "published" or row["plan_status"] == "posted":
        return "posted"
    if row["post_id"] or row["plan_status"] == "written":
        return "written"
    return "missed" if row["publish_date"] < today else "planned"


def _item(record: asyncpg.Record, today: dt.date) -> dict:
    out = _plain(record)
    out["status"] = _status(dict(record), today)
    for key in ("planStatus", "postStatus"):
        out.pop(key)
    return out


@router.post("/import")
async def import_plan(request: Request, user: Admin, dry_run: Annotated[bool, Query()] = False) -> dict:
    """Check the uploaded plan and, unless dry_run, save it in one transaction. Same id = update that brief; a
    brief whose blog is already posted is never changed. Nothing is saved while the file has errors (422)."""
    raw = await request.body()
    if len(raw) > MAX_BYTES:
        raise HTTPException(413, "The file is larger than 1 MB.")
    try:
        payload = json.loads(raw)
    except ValueError as exc:
        raise HTTPException(400, "The file is not valid JSON.") from exc

    entries, errors, warnings = validate(payload, _today())
    pool = await _db()
    async with pool.acquire() as conn, conn.transaction():
        lock = "" if dry_run or errors else " for update of b"
        # Posted = marked posted, or its linked post is published (the post can be published without the plan
        # row being updated).
        existing = {
            r["external_id"]: r["posted"]
            for r in await conn.fetch(
                f"""select b.external_id, (b.status = 'posted' or p.status is not distinct from 'published') as posted
                    from public.blog_plan b left join content_posts p on p.id = b.post_id
                    where b.external_id = any($1::text[]){lock}""",  # noqa: S608 - lock is a constant
                [e["external_id"] for e in entries],
            )
        }
        actions = {
            e["external_id"]: "skipped" if existing.get(e["external_id"])
            else "update" if e["external_id"] in existing else "new"
            for e in entries
        }
        saved = not dry_run and not errors
        if saved:
            for e in entries:
                if actions[e["external_id"]] == "skipped":
                    continue
                await conn.execute(
                    """insert into public.blog_plan (external_id, topic, category, keywords, publish_date, tone,
                                                     length, target_versions, reference_urls, uploaded_by)
                       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                       on conflict (external_id) do update set
                         topic = excluded.topic, category = excluded.category, keywords = excluded.keywords,
                         publish_date = excluded.publish_date, tone = excluded.tone, length = excluded.length,
                         target_versions = excluded.target_versions, reference_urls = excluded.reference_urls,
                         uploaded_by = excluded.uploaded_by, updated_at = now(),
                         status = case when blog_plan.status = 'cancelled' then 'planned' else blog_plan.status end
                       where blog_plan.status <> 'posted'
                         and not exists (select 1 from content_posts p
                                         where p.id = blog_plan.post_id and p.status = 'published')""",
                    e["external_id"], e["topic"], e["category"], e["keywords"], e["publish_date"], e["tone"],
                    e["length"], e["target_versions"], e["reference_urls"], (user.get("email") or user["sub"])[:200],
                )

    count = Counter(actions.values())
    report = {
        "saved": saved,
        "created": count["new"] if saved else 0,
        "updated": count["update"] if saved else 0,
        "skipped": count["skipped"],
        "errors": errors,
        "warnings": warnings,
        # One row per entry for the preview, in file order (entries with errors are listed by their errors).
        "items": [
            {"id": e["external_id"], "topic": e["topic"], "category": e["category"],
             "publishDate": e["publish_date"].isoformat(), "action": actions[e["external_id"]]}
            for e in entries
        ],
    }
    if errors and not dry_run:
        raise HTTPException(422, report)
    return report


@router.get("")
async def plan(_user: User) -> dict:
    """The schedule, soonest first, with counts for the summary boxes."""
    today = _today()
    pool = await _db()
    items = [_item(r, today) for r in await pool.fetch(f"{_PLAN} order by b.publish_date, b.external_id")]  # noqa: S608
    active = [i for i in items if i["status"] != "cancelled"]
    monday = today - dt.timedelta(days=today.weekday())
    week = {(monday + dt.timedelta(days=d)).isoformat() for d in range(7)}
    upcoming = [i for i in active if i["status"] in ("planned", "written") and i["publishDate"] >= today.isoformat()]
    return {
        "total": len(active),
        "byStatus": dict(Counter(i["status"] for i in items)),
        "thisWeek": sum(1 for i in active if i["publishDate"] in week),
        "next": upcoming[0] if upcoming else None,
        "items": items,
    }


@router.get("/{plan_id}")
async def plan_entry(plan_id: str, _user: User) -> dict:
    pool = await _db()
    try:
        row = await pool.fetchrow(f"{_PLAN} where b.id = $1::uuid", plan_id)  # noqa: S608
    except asyncpg.DataError as exc:
        raise HTTPException(404, "Not found") from exc
    if row is None:
        raise HTTPException(404, "Not found")
    return _item(row, _today())


@router.post("/{plan_id}/cancel")
async def cancel(plan_id: str, _admin: Admin) -> dict:
    """Drop a brief from the schedule. Not possible once its blog is posted."""
    pool = await _db()
    try:
        row = await pool.fetchrow(f"{_PLAN} where b.id = $1::uuid", plan_id)  # noqa: S608
    except asyncpg.DataError as exc:
        raise HTTPException(404, "Not found") from exc
    if row is None:
        raise HTTPException(404, "Not found")
    if _status(dict(row), _today()) == "posted":
        raise HTTPException(409, "This blog is already posted.")
    await pool.execute(
        "update public.blog_plan set status = 'cancelled', updated_at = now() where id = $1::uuid", plan_id
    )
    return _item(await pool.fetchrow(f"{_PLAN} where b.id = $1::uuid", plan_id), _today())  # noqa: S608
