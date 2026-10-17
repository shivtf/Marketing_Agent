"""Rules for the mail the dashboard reads from Gmail (app/inbox.py): bounces, automatic replies and unsubscribe wording.

These are deliberately simple and conservative. Bounces and out-of-office replies are written by machines, so their
senders and headers give them away; no model is needed. Unsubscribe wording is a safety net: a reply that seems to ask
to stop is never shown as an ordinary lead until a person has looked at it.
"""

import re

# Same senders as the mail agent's bounce check (agent/inbox.py): "delayed" notices are not bounces.
_BOUNCE_SENDERS = ("mailer-daemon@", "postmaster@")

# RFC 3834 and the headers common mail servers add to automatic replies.
_AUTO_HEADERS = ("x-autoreply", "x-autorespond", "x-autoresponder")
_AUTO_SUBJECT = re.compile(
    r"\b(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|away from (the )?office|on (annual )?leave|"
    r"on vacation|abwesenheit|absence)\b",
    re.IGNORECASE,
)

# Asks to stop. Kept narrow: "not interested" alone is a refusal, not an unsubscribe request.
_UNSUBSCRIBE = re.compile(
    r"\b(unsubscribe|opt[- ]?out|remove (me|us|my (email|address))|take (me|us) off|"
    r"(stop|quit|cease) (emailing|contacting|sending|messaging|writing)|"
    r"(do not|don'?t|never) (email|contact|write to|message) (me|us)( again)?)\b",
    re.IGNORECASE,
)

MESSAGE_ID = re.compile(r"<[^<>\s]+@[^<>\s]+>")


def is_bounce(sender: str, subject: str) -> bool:
    """A permanent delivery-failure notice from a mail system."""
    return sender.startswith(_BOUNCE_SENDERS) and "delay" not in (subject or "").lower()


def is_auto_reply(headers: dict[str, str], subject: str) -> bool:
    """An out-of-office or other automatic reply. headers: lower-case name -> value."""
    auto = headers.get("auto-submitted", "").strip().lower()
    if auto and auto != "no":
        return True
    if any(h in headers for h in _AUTO_HEADERS):
        return True
    if headers.get("precedence", "").strip().lower() == "auto_reply":
        return True
    return bool(_AUTO_SUBJECT.search(subject or ""))


def mentions_unsubscribe(text: str | None) -> bool:
    return bool(_UNSUBSCRIBE.search(text or ""))


def message_ids(*values: str | None) -> list[str]:
    """Every <...@...> Message-ID in the given header values or text, in order, without repeats."""
    seen: list[str] = []
    for v in values:
        for m in MESSAGE_ID.findall(v or ""):
            if m not in seen:
                seen.append(m)
    return seen
