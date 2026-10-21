"""Dashboard backend. Supabase handles sign-in; this API verifies the JWT on every protected call."""

import asyncio
import contextlib
import os
from contextlib import asynccontextmanager
from typing import Annotated

from dotenv import load_dotenv
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.accounts import router as accounts_router
from app.auth import current_user, release
from app.blog_posts import router as blog_posts_router
from app.data import router as data_router
from app.inbox import check_every, check_interval
from app.inbox import router as inbox_router
from app.needs_contact import router as needs_contact_router

load_dotenv()  # reads dashboardbackend/.env when started from that folder


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Starts the scheduled inbox check (app/inbox.py) when INBOX_CHECK_EVERY_MINUTES is set."""
    minutes = check_interval()
    task = asyncio.create_task(check_every(minutes)) if minutes else None
    yield
    if task:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


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
