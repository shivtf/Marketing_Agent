"""Posting approved blogs to Dev.to (Blogs page). The Marketing Agent no longer posts blogs; this backend does.

An admin approves each blog of a weekly blog file on the Blogs page (the dashboard's Next server writes blog_approval,
migrations/010_blog_approval.sql). An admin then clicks "Post today's blogs", which calls POST /blog-posts/post-today:
every blog approved for today (BLOG_TIMEZONE) that isn't posted yet is posted, one at a time, as the copy that was
approved. Each one is first claimed in blog_posts (migrations/011_blog_posts.sql) as 'posting', and the claim checks
the approval again, so a blog taken back is skipped and a second click, or another server, never posts it twice.
Nothing is retried on its own: a failed blog waits for an admin's "Post again" (POST /blog-posts/post-again). Dev.to
may have posted it even though no answer came back, so a blog tried before is first looked for on Dev.to (same title)
and only recorded when it is already there. The same call posts an approved blog nobody posted on its
day. Both until the Saturday of the blog's week (Monday to Saturday), as the next week's file comes on Sunday.

  GET  /blog-posts/mode                             -> { mode: off | draft | live } (any signed-in user)
  POST /blog-posts/post-today                       -> { mode, day, posted, failed, skipped }
  POST /blog-posts/post-again { fileName, blogId }  -> the same, for that one blog: failed, stuck while 'posting', or
                                                       missed (approved, never posted), dated this week up to today

Settings (Render): BLOG_POSTING = off (default: nothing is posted) | draft (Dev.to drafts, for testing) | live;
DEVTO_API_KEY; BLOG_TIMEZONE (default Asia/Kolkata). Admins only. Errors are 503 / 502 / 422, never 401 / 409 (the
dashboard signs the user out on those).
"""

import asyncio
import json
import logging
import os
import re
from datetime import date, datetime, timedelta
from typing import Annotated
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import asyncpg
import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.auth import current_admin, current_user
from app.data import _pg

log = logging.getLogger(__name__)
router = APIRouter(prefix="/blog-posts", dependencies=[Depends(current_user)])
Admin = Annotated[dict, Depends(current_admin)]

DEVTO_URL = "https://dev.to/api/articles"
MIGRATION = "Run migrations/010_blog_approval.sql and 011_blog_posts.sql in the Supabase SQL editor first."
_lock = asyncio.Lock()  # one posting run at a time in this process; the blog_posts claim guards the rest


class PostAgainIn(BaseModel):
    fileName: str = Field(max_length=64)
    blogId: str = Field(max_length=200)


class PostError(Exception):
    """A blog that couldn't be posted; the message is shown on the Blogs page."""


def posting_mode() -> str:
    mode = os.environ.get("BLOG_POSTING", "").strip().lower()
    return mode if mode in ("draft", "live") else "off"


def week_start(day: date) -> date:
    """The earliest date of a blog that may still be posted late on `day`: the Monday of its week (Monday to Saturday).
    On a Sunday, only that day's blogs: the week before has ended (the dashboard's lastPostDay says the same)."""
    return day if day.isoweekday() == 7 else day - timedelta(days=day.isoweekday() - 1)


def today() -> date:
    name = os.environ.get("BLOG_TIMEZONE", "").strip() or "Asia/Kolkata"
    try:
        return datetime.now(ZoneInfo(name)).date()
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise HTTPException(503, f"BLOG_TIMEZONE is not a known timezone: {name}") from exc


# ---------- What is sent to Dev.to ----------


def devto_tags(keywords) -> list[str]:
    """Dev.to takes at most 4 tags, lowercase letters and digits only: 'CI/CD' -> 'cicd'."""
    tags: list[str] = []
    for k in keywords if isinstance(keywords, list) else []:
        tag = re.sub(r"[^a-z0-9]", "", str(k).lower())
        if tag and tag not in tags:
            tags.append(tag)
    return tags[:4]


def article(blog: dict) -> tuple[str, str, list[str]]:
    """The approved blog (as written in the weekly file) -> (title, markdown body, tags). The headline is its `title`,
    else its `topic` (older files have no title), else its id. Dev.to shows the title above the post, so a '# heading'
    first line in the content is left out."""
    title = next((str(blog.get(k)).strip() for k in ("title", "topic", "id") if str(blog.get(k) or "").strip()), "")
    body = blog.get("content") if isinstance(blog.get("content"), str) else ""
    lines = body.strip().splitlines()
    if lines and re.match(r"^#\s+\S", lines[0]):
        body = "\n".join(lines[1:]).strip()
    return title, body.strip(), devto_tags(blog.get("keywords"))


async def post_to_devto(title: str, body: str, tags: list[str], publish: bool) -> tuple[str, str]:
    """-> (url, Dev.to id), or PostError saying what happened."""
    key = os.environ.get("DEVTO_API_KEY", "").strip()
    payload = {"article": {"title": title, "body_markdown": body, "published": publish, "tags": tags}}
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            res = await client.post(DEVTO_URL, json=payload,
                                    headers={"api-key": key, "Accept": "application/vnd.forem.api-v1+json"})
    except httpx.ConnectError as exc:
        raise PostError("Couldn't reach Dev.to, so nothing was posted. Try Post again.") from exc
    except httpx.HTTPError as exc:  # sent, but no answer: it may be on Dev.to anyway
        raise PostError("Dev.to didn't answer. It may have posted it anyway: Post again looks there first.") from exc
    if res.status_code in (401, 403):
        raise PostError("Dev.to refused the API key (DEVTO_API_KEY on the backend).")
    if res.status_code == 429:
        raise PostError("Dev.to asked to slow down. Try Post again in a minute.")
    if res.status_code >= 500:
        raise PostError(f"Dev.to had an error ({res.status_code}). Post again looks there first.")
    if res.status_code >= 400:
        try:
            detail = res.json().get("error") or res.text
        except ValueError:
            detail = res.text
        raise PostError(f"Dev.to refused it ({res.status_code}): {str(detail)[:300]}")
    try:
        data = res.json()
    except ValueError:  # it took the post (2xx) but its answer can't be read: posted, address unknown
        log.warning("Dev.to answered %s without JSON", res.status_code)
        return "", ""
    return str(data.get("url") or ""), str(data.get("id") or "")


async def find_on_devto(title: str, published: bool) -> tuple[str, str] | None:
    """A post of ours on Dev.to with this exact title, published or a draft as asked -> (url, Dev.to id), or None.
    Looked up before a blog is posted again, because an earlier try may have reached Dev.to without our knowing (no
    answer, or the server stopped before recording it). Only our latest 100 posts are looked at."""
    key = os.environ.get("DEVTO_API_KEY", "").strip()
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            res = await client.get(f"{DEVTO_URL}/me/all", params={"per_page": 100},
                                   headers={"api-key": key, "Accept": "application/vnd.forem.api-v1+json"})
        res.raise_for_status()
        posts = res.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise PostError("Couldn't check Dev.to for a copy posted earlier, so nothing was posted. "
                        "Try Post again in a minute.") from exc
    for a in posts if isinstance(posts, list) else []:
        if (a.get("title") or "").strip() == title.strip() and bool(a.get("published")) == published:
            return str(a.get("url") or ""), str(a.get("id") or "")
    return None


# ---------- Claim, post, record ----------

_APPROVED = """
select file_name, blog_id, blog, blog_hash, publish_date from blog_approval
where status = 'approved'
"""

# Takes the blog for posting if it is still approved, for its day ($8) and this version, and nobody posted it. A blog
# already in blog_posts is taken again only when it was posted as a draft and posting is now live, or, on "Post
# again" ($9), when it failed or has been left 'posting' for 15 minutes (the server stopped mid-post). -> its blog_posts id, or nothing.
_CLAIM = """
insert into blog_posts as p (file_name, blog_id, status, draft, title, body_md, blog_hash, started_by)
select $1, $2, 'posting', $3, $4, $5, $6, $7
where exists (select 1 from blog_approval a where a.file_name = $1 and a.blog_id = $2 and a.status = 'approved'
              and a.blog_hash = $6 and a.publish_date = $8)
on conflict (file_name, blog_id) do update
  set status = 'posting', draft = excluded.draft, title = excluded.title, body_md = excluded.body_md,
      blog_hash = excluded.blog_hash, started_by = excluded.started_by, started_at = now(),
      attempts = p.attempts + 1, url = null, site_post_id = null, error = null, posted_at = null
  where (p.status = 'posted' and p.draft and not excluded.draft)
     or ($9 and (p.status = 'failed' or (p.status = 'posting' and p.started_at < now() - interval '15 minutes')))
returning id, attempts
"""
_POSTED = "update blog_posts set status = 'posted', url = $2, site_post_id = $3, posted_at = now() where id = $1"


async def _post_one(pool, row, mode: str, by: str, again: bool) -> dict | None:
    """Posts one approved blog. -> { fileName, blogId, url, draft } or { fileName, blogId, error }; None when it was
    not taken (already posted or being posted, or no longer approved). A blog tried before is first looked for on
    Dev.to, and recorded instead of posted when it is already there, so it is never posted twice."""
    blog = row["blog"] if isinstance(row["blog"], dict) else json.loads(row["blog"])
    title, body, tags = article(blog)
    draft = mode == "draft"
    claim = await pool.fetchrow(_CLAIM, row["file_name"], row["blog_id"], draft, title, body, row["blog_hash"], by,
                                row["publish_date"], again)
    if claim is None:
        return None
    post_id = claim["id"]
    out = {"fileName": row["file_name"], "blogId": row["blog_id"]}
    try:
        if not body:
            raise PostError("The blog has no content.")
        found = await find_on_devto(title, published=not draft) if claim["attempts"] > 1 else None
        if found:
            url, site_id = found
            log.info("Blog %s / %s was already on Dev.to: recorded, not posted again", row["file_name"], row["blog_id"])
        else:
            url, site_id = await post_to_devto(title, body, tags, publish=not draft)
    except PostError as exc:
        await pool.execute("update blog_posts set status = 'failed', error = $2 where id = $1", post_id, str(exc))
        log.warning("Blog %s / %s not posted: %s", row["file_name"], row["blog_id"], exc)
        return {**out, "error": str(exc)}
    if not url and not found:  # posted, but its address didn't come back: look it up (best effort)
        try:
            url, site_id = await find_on_devto(title, published=not draft) or (url, site_id)
        except PostError:
            pass
    # It is on Dev.to now: record it, retrying a few times. If the database still refuses, the row stays 'posting', and
    # Post again (after 15 minutes) finds the post on Dev.to instead of posting it twice.
    for attempt in range(3):
        try:
            await pool.execute(_POSTED, post_id, url, site_id)
            break
        except (asyncpg.PostgresError, OSError):
            if attempt == 2:
                log.error("Blog %s / %s posted to Dev.to (%s) but not recorded", row["file_name"], row["blog_id"], url,
                          exc_info=True)
                return {**out, "error": f"Posted to Dev.to ({url or 'address unknown'}), but couldn't record it. "
                                       "In 15 minutes, Post again records it without posting it twice."}
            await asyncio.sleep(1 + attempt)
    log.info("Blog %s / %s posted to Dev.to%s by %s: %s", row["file_name"], row["blog_id"],
             " as a draft" if draft else "", by, url)
    return {**out, "url": url, "draft": draft}


async def _run(rows, day: date, by: str, again: bool) -> dict:
    mode = posting_mode()
    if mode == "off":
        raise HTTPException(503, "Posting is off on the backend (set BLOG_POSTING to draft or live).")
    if not os.environ.get("DEVTO_API_KEY", "").strip():
        raise HTTPException(503, "DEVTO_API_KEY is not set on the backend.")
    pool = await _pg()
    result = {"mode": mode, "day": day.isoformat(), "posted": [], "failed": [], "skipped": 0}
    for row in rows:
        done = await _post_one(pool, row, mode, by, again)
        if done is None:
            result["skipped"] += 1
        else:
            result["failed" if "error" in done else "posted"].append(done)
    return result


async def _guarded(work):
    async with _lock:
        try:
            return await work()
        except (asyncpg.UndefinedTableError, asyncpg.InsufficientPrivilegeError) as exc:
            log.error("Blog posting needs its migrations", exc_info=True)
            raise HTTPException(503, MIGRATION) from exc


@router.get("/mode")
async def mode() -> dict:
    """What Post today's blogs does right now, so the page can say so (and hide the button while posting is off)."""
    return {"mode": posting_mode()}


@router.post("/post-today")
async def post_today(admin: Admin) -> dict:
    """Posts every blog approved for today that isn't posted yet."""
    by = admin.get("email") or admin["sub"]

    async def work():
        day = today()
        rows = await (await _pg()).fetch(_APPROVED + " and publish_date = $1 order by file_name, blog_id", day)
        return await _run(rows, day, by, again=False)

    return await _guarded(work)


@router.post("/post-again")
async def post_again(body: PostAgainIn, admin: Admin) -> dict:
    """Posts one approved blog whose posting failed, stopped half way, or never happened (missed), until the Saturday
    of its week."""
    by = admin.get("email") or admin["sub"]

    async def work():
        day = today()
        rows = await (await _pg()).fetch(
            _APPROVED + " and publish_date between $4 and $1 and file_name = $2 and blog_id = $3",
            day, body.fileName, body.blogId, week_start(day))
        if not rows:
            raise HTTPException(422, "Only an approved blog from this week (Monday to Saturday), dated today or earlier, can be posted.")
        result = await _run(rows, day, by, again=True)
        if result["skipped"]:
            raise HTTPException(422, "This blog is already posted or being posted.")
        return result

    return await _guarded(work)
