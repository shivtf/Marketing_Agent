"""Qualified leads the Marketing Agent found no contact for, and the one write the dashboard makes to them.

The agent keeps such a company as lead_status NEEDS_CONTACT (Marketing-AI-Agent migration 0013). A person looks the company
up, types an email here, and submit_manual_contact() (SQL, same migration) stores it and moves the lead on. The agent then
drafts the email and posts the approval request to Slack. Nothing is sent from here, and approval in Slack stays the only
way an email goes out.

Paths start with /needs-contact, not /leads: /leads/{lead_id} in app/data.py would otherwise answer first.
"""

import logging
import uuid
from typing import Annotated

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.auth import current_user
from app.data import PAGE_SIZE, Limit, PageNo, _page, _pg

log = logging.getLogger(__name__)
router = APIRouter(dependencies=[Depends(current_user)])
User = Annotated[dict, Depends(current_user)]

# Best leads first: the person has limited time, so the strongest companies come on top.
_NEEDS_CONTACT = """
select co.id, co.name as company, 'https://' || co.domain as website, co.lead_score as score,
       coalesce(nullif(btrim(co.opportunity), ''), nullif(btrim(co.project_summary), ''),
                nullif(btrim(co.industry), '')) as about,
       co.contact_form_url as form_url, co.status_note as reason, co.updated_at as since
from companies co
where co.lead_status = 'NEEDS_CONTACT'
"""


class ManualContact(BaseModel):
    email: str = Field(max_length=254)
    name: str | None = Field(default=None, max_length=120)
    role: str | None = Field(default=None, max_length=120)


# What submit_manual_contact() answers, as the person should read it. 422/404, never 409: the dashboard treats 409 as
# "this account is signed in elsewhere" and signs the user out.
_REFUSED = {
    "invalid": (422, "That does not look like an email address."),
    "suppressed": (422, "That address asked not to be contacted, so it cannot be used."),
    "not_waiting": (422, "This company no longer needs a contact. Someone may already have added one: reload the list."),
    "unknown": (404, "Company not found."),
}


@router.get("/needs-contact")
async def needs_contact(page: PageNo = 1, limit: Limit = PAGE_SIZE) -> dict:
    """Companies waiting for an email -> { items, total, page, limit }. Strongest first."""
    return await _page(_NEEDS_CONTACT, "score desc nulls last, since desc, id", page, limit)  # unscored last


@router.post("/needs-contact/{lead_id}/contact")
async def add_contact(lead_id: str, body: ManualContact, user: User) -> dict:
    """Saves the email for a company. The agent drafts the email and asks for approval in Slack within about 30 seconds."""
    try:
        company = str(uuid.UUID(lead_id))
    except ValueError as exc:
        raise HTTPException(404, "Company not found.") from exc
    who = user.get("email") or user["sub"]
    try:
        result = await (await _pg()).fetchval(
            "select submit_manual_contact($1::uuid, $2, $3, $4, $5)", company, body.email, body.name, body.role, who
        )
    except asyncpg.PostgresError as exc:
        log.error("Could not save the contact", exc_info=True)
        raise HTTPException(503, "Couldn't save the email: the database refused it. Try again.") from exc
    if result != "ok":
        status, detail = _REFUSED.get(result, (503, "Couldn't save the email."))
        raise HTTPException(status, detail)
    log.info("Contact added for %s by %s", company, who)
    return {"ok": True}
