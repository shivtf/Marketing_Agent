"""Rules for the mail the dashboard reads from Gmail (app/inbox.py): bounces, automatic replies, unsubscribe wording,
and the keyword score that sorts a person's reply on Positive Leads (app/data.py).

These are deliberately simple and conservative. Bounces and out-of-office replies are written by machines, so their
senders and headers give them away; no model is needed. Unsubscribe wording is a safety net: a reply that seems to ask
to stop is never shown as an ordinary lead until a person has looked at it. The keyword score is a first sort, not a
verdict: anything unclear lands in Needs review, and a person's label always wins.
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


# ---------- Keyword score ----------
# How positive a reply is, from 0 (a clear no) to 1 (a clear yes). Every reply starts at NEUTRAL; each phrase below that
# appears adds its weight (each phrase counts once). Edit the lists to tune it: a phrase is a regular expression, matched
# case-insensitively on whole words, with straight quotes (curly ones are turned into straight ones first).
#
# Order matters: the "no" phrases are looked for first and the words they matched are blanked out, so "not interested"
# can never also count as "interested"; then the strong phrases before the weak ones, for the same reason.

NEUTRAL = 0.5
POSITIVE_AT = 0.7  # this score or more: Positive
REVIEW_AT = 0.4  # from here up to POSITIVE_AT: Needs review; below it: Not interested

_NOT = r"(not|never|no longer|don't|doesn't|didn't|wouldn't|won't|isn't|aren't|wasn't|am not|are not|is not)"

STRONG_NO = -0.3
SOFT_NO = -0.2
STRONG_YES = 0.25
SOFT_YES = 0.15

_PHRASES: list[tuple[float, str]] = [
    # A clear no.
    (STRONG_NO, rf"{_NOT}( \w+){{0,2}} interested"),
    (STRONG_NO, r"no interest"),
    (STRONG_NO, r"no,? thank(s| you)"),
    (STRONG_NO, r"(we're|we are|i'm|i am) (all set|good for now|covered)"),
    (STRONG_NO, r"not (a|the) (good |right )?fit"),
    (STRONG_NO, r"(not|aren't|are not|isn't|is not) (looking|in the market) for"),
    (STRONG_NO, r"already (have|use|using|work with|working with|partner with)"),
    (STRONG_NO, r"(decided|chose|chosen) (to go with|another|against)"),
    (STRONG_NO, r"(no|zero) (budget|need|bandwidth)"),
    (STRONG_NO, r"please don't"),
    # A soft no: often "not now" rather than "never".
    (SOFT_NO, r"not (right )?now"),
    (SOFT_NO, r"not at (this|the moment|the present) ?(time|moment)?"),
    (SOFT_NO, r"not a priority"),
    (SOFT_NO, r"(maybe|perhaps) (later|next (quarter|year))"),
    (SOFT_NO, r"(too busy|no time)"),
    (SOFT_NO, r"unfortunately"),
    (SOFT_NO, r"pass on this"),
    # A clear yes: they want a call, details or to move forward.
    (STRONG_YES, r"let's (talk|chat|connect|meet|speak|schedule|set up|book|do it|go|discuss)"),
    (STRONG_YES, r"(schedule|book|set up|arrange|organi[sz]e|jump on|hop on) (a |an |the )?(quick |short )?"
                 r"(call|meeting|demo|chat|time)"),
    (STRONG_YES, r"send (me |us |over )?(the |more |some |a few |your )?"
                 r"(details|info|information|proposal|deck|pricing|quote|times|slots|availability)"),
    (STRONG_YES, r"(i'm|i am|we're|we are) (very |definitely |really |quite |genuinely )?interested"),
    (STRONG_YES, r"(happy|glad|keen|love|like) to (talk|chat|connect|meet|learn more|hear more|discuss|speak|see)"),
    (STRONG_YES, r"what (time|times|day|days) (works|work|suits|suit|is good|are good)"),
    (STRONG_YES, r"(works for me|sounds (good|great|perfect)|count me in|i'm in|we're in)"),
    (STRONG_YES, r"(my|our) (calendar|calendly)"),
    # A soft yes: interest, but no step forward yet.
    (SOFT_YES, r"(sounds|looks|seems) (interesting|intriguing|promising|relevant|useful)"),
    (SOFT_YES, r"tell me more|learn more|hear more|more (details|info|information)"),
    (SOFT_YES, r"(good|perfect|great) timing"),
    (SOFT_YES, r"interested|curious"),
]
_COMPILED = [(w, re.compile(rf"\b{p}\b", re.IGNORECASE)) for w, p in _PHRASES]

# A whole reply of a word or two ("Sure.", "No."), checked line by line on short replies only.
_SHORT_YES = re.compile(r"^(yes|yeah|yep|sure|ok|okay|absolutely|definitely|of course|yes,? please|interested)[.!]*$",
                        re.IGNORECASE)
_SHORT_NO = re.compile(r"^(no|nope|pass)[.!]*$", re.IGNORECASE)
_SHORT_WORDS = 12

# Asks something before deciding. A question goes to Questions unless the reply is clearly positive or says no.
_QUESTION = re.compile(
    r"\?|\b(how much|pricing|what (does|would|will) (it|this) cost|how does (it|this) work|what (is|are) the "
    r"(cost|price|prices|timeline|process|next steps))\b",
    re.IGNORECASE,
)


def score_reply(text: str | None) -> dict:
    """What the person wrote (quoted mail already removed) -> {score, hits: [{phrase, weight}], question}.
    score: NEUTRAL plus the weights of the phrases found, between 0 and 1. hits: what matched, in the order found."""
    text = (text or "").replace("\u2019", "'").replace("\u2018", "'")
    hits: list[dict] = []
    lines = [line.strip() for line in text.splitlines()]
    if len(text.split()) <= _SHORT_WORDS:  # a short reply: a line that is only "Sure." or "No." counts, once
        for i, line in enumerate(lines):
            for rx, weight in ((_SHORT_YES, STRONG_YES), (_SHORT_NO, STRONG_NO)):
                if rx.match(line):
                    hits.append({"phrase": line.rstrip(".!").lower(), "weight": weight})
                    lines[i] = ""
    t = " ".join(" ".join(lines).split())

    def take(m: re.Match, weight: float) -> str:
        hits.append({"phrase": m.group(0).lower(), "weight": weight})
        return " " * len(m.group(0))  # blank it out, so a weaker phrase can't count the same words again

    for weight, rx in _COMPILED:
        t, _ = rx.subn(lambda m, w=weight: take(m, w), t, count=1)
    score = min(1.0, max(0.0, NEUTRAL + sum(h["weight"] for h in hits)))
    return {"score": round(score, 2), "hits": hits, "question": bool(_QUESTION.search(text))}
