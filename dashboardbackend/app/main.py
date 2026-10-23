"""Dashboard backend. Supabase handles sign-in; this API verifies the JWT on every protected call."""

import asyncio
import contextlib
import logging
import os
from contextlib import asynccontextmanager
from typing import Annotated

from dotenv import load_dotenv
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.accounts import router as accounts_router
from app.auth import current_user, release
from app.blog_posts import router as blog_posts_router
from app.data import _pg, refresh_leads
from app.data import router as data_router
from app.inbox import check_every, check_interval
from app.inbox import router as inbox_router
from app.needs_contact import router as needs_contact_router

load_dotenv()  # reads dashboardbackend/.env when started from that folder

log = logging.getLogger(__name__)


async def refresh_leads_every(seconds: float) -> None:
    """Rebuilds the lead list on a timer, so what the agent writes on its own (new leads, sent emails) shows up.
    Replies, labels and manual contacts refresh it at once (data.refresh_leads)."""
    while True:
        await asyncio.sleep(seconds)
        await refresh_leads()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Opens the database pool, so the first request does not pay for the connection (TCP + TLS), and starts the
    scheduled inbox check (app/inbox.py) when INBOX_CHECK_EVERY_MINUTES is set."""
    try:
        await _pg()
    except Exception:  # noqa: BLE001 - e.g. DATABASE_URL not set: the routes report that themselves
        log.warning("Could not open the database pool at startup", exc_info=True)
    minutes = check_interval()
    task = asyncio.create_task(check_every(minutes)) if minutes else None
    # LEADS_REFRESH_SECONDS=0 turns it off (e.g. when pg_cron does it, see migrations/015_leads_my.sql).
    every = float(os.environ.get("LEADS_REFRESH_SECONDS", "60"))
    refresher = asyncio.create_task(refresh_leads_every(every)) if every > 0 else None
    yield
    for t in (task, refresher):
        if t:
            t.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await t


app = FastAPI(title="Dashboard backend", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        o.strip()
        for o in os.environ.get("CORS_ORIGINS", "http://localhost:3000").split(",")
        if o.strip()
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)


app.include_router(data_router)
app.include_router(accounts_router)
app.include_router(needs_contact_router)
app.include_router(inbox_router)
app.include_router(blog_posts_router)


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.get("/auth/me")
def me(user: Annotated[dict, Depends(current_user)]) -> dict:
    # The dashboard role (admin / employee), not the token's own "role" claim, which is always "authenticated".
    return {"id": user["sub"], "email": user.get("email"), "role": (user.get("app_metadata") or {}).get("role")}


@app.post("/auth/signout")
async def signout(user: Annotated[dict, Depends(current_user)]) -> dict:
    """Frees the account for another sign-in right away (the browser then ends its Supabase session)."""
    if user.get("session_id"):
        await release(user["sub"], user["session_id"])
    return {"ok": True}
