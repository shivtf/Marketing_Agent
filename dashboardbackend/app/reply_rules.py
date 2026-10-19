"""Rules for the mail the dashboard reads from Gmail (app/inbox.py): bounces, automatic replies, unsubscribe wording,
and the keyword score that sorts a person's reply on Positive Leads (app/data.py).

These are deliberately simple and conservative. Bounces and out-of-office replies are written by machines, so their
senders and headers give them away; no model is needed. Unsubscribe wording is a safety net: a reply that seems to ask
to stop is never shown as an ordinary lead until a person has looked at it. The keyword score is a first sort, not a
verdict: anything unclear lands in Needs review, and a person's label always wins.
"""

import re

# Mail systems' own senders (Exchange's carries a number: microsoftexchange329e...@): "delayed" notices are not bounces.
_BOUNCE_SENDERS = ("mailer-daemon@", "postmaster@", "microsoftexchange")

# RFC 3834 and the headers common mail servers add to automatic replies.
_AUTO_HEADERS = ("x-autoreply", "x-autorespond", "x-autoresponder")
# Words only an automatic reply uses, anywhere in the subject; and words a person may use too ("Re: absence of a plan"),
# which count only at the start ("Absence: back on Monday").
_AUTO_SUBJECT = re.compile(
    r"\b(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|abwesenheitsnotiz|réponse automatique|"
    r"respuesta automática)\b"
    r"|^\s*(away from (the )?office|on (annual )?leave|on vacation|abwesenheit|absence|auto)\s*(:|$)",
    re.IGNORECASE,
)

# Asks to stop. Kept narrow: "not interested" alone is a refusal, not an unsubscribe request, and "remove me from this
# thread" only asks to be left out of one conversation.
_UNSUBSCRIBE = re.compile(
    r"\b(unsubscribe|opt[- ]?out|remove (me|us|my (email|address))(?! from (this|the) (thread|conversation|chain|cc|loop))|"
    r"take (me|us) off(?! (this|the) (thread|conversation|chain|cc|loop))|"
    r"(stop|quit|cease) (emailing|contacting|sending|messaging|writing)|"
    r"(do not|don'?t|never) (email|contact|write to|message) (me|us)( again)?)\b",
    re.IGNORECASE,
)

MESSAGE_ID = re.compile(r"<[^<>\s]+@[^<>\s]+>")


def is_bounce(sender: str, subject: str, headers: dict[str, str] | None = None) -> bool:
    """A permanent delivery-failure notice from a mail system: from its sender, or a delivery report (RFC 3464)."""
    report = "report-type=delivery-status" in (headers or {}).get("content-type", "").lower()
    return (sender.startswith(_BOUNCE_SENDERS) or report) and "delay" not in (subject or "").lower()


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


# ---------- What the person wrote ----------
# A reply carries our quoted email, a signature and footers; only what the person wrote is scored. Our own email ends in
# "Unsubscribe: <link>", so a quote left in would look like an unsubscribe request.

# Where the quoted earlier mail starts. "On ... wrote:" may be wrapped over two lines, or written in another language.
_QUOTE_START = re.compile(r"^(-{2,}\s*original message|_{10,}\s*$|-{5,}\s*forwarded message)", re.IGNORECASE)
_WROTE = re.compile(r"\b(wrote|schrieb|a écrit|escribió|ha scritto|schreef|skrev|napisał|escreveu|kirjoitti)\b.*:\s*$",
                    re.IGNORECASE)
_WROTE_START = re.compile(r"^(on|am|le|el|il|op|den|w dniu|em|on \w+day)\b", re.IGNORECASE)
# Outlook's header block: "From: ..." followed by "Sent:" / "Date:" (the address is often only a name).
_HEADER = re.compile(r"^\*?(from|von|de|van|da)\s*:\*?\s", re.IGNORECASE)
_HEADER_NEXT = re.compile(r"^\*?(sent|date|gesendet|datum|envoyé|enviado|to|an|à|para)\s*:\*?\s", re.IGNORECASE)
# The end of what the person wrote: the signature delimiter, "Sent from my iPhone".
_SIGNATURE = re.compile(r"^(--\s*|sent from my .{1,40}|get outlook for .{1,20})$", re.IGNORECASE)
# Mailing-list footers (ours, or their company's): never a request from the person.
_FOOTER = re.compile(r"^(unsubscribe\s*:|to unsubscribe\b|click here to unsubscribe|if you (would like|wish|want|no "
                     r"longer wish) to (unsubscribe|stop receiving))", re.IGNORECASE)
_GREETING = re.compile(r"^(hi|hello|hey|dear|good (morning|afternoon|evening))\b.{0,40}$", re.IGNORECASE)


def _norm(line: str) -> str:
    return " ".join(line.lstrip("> ").split()).lower()


def strip_quoted(body: str | None, ours: str | None = None) -> str:
    """What the person wrote: stops at quoted earlier mail or their signature, and leaves out quoted lines ("> "),
    footers and any line copied from `ours` (the email of ours they answer)."""
    lines = (body or "").splitlines()
    sent = {_norm(x) for x in (ours or "").splitlines() if len(_norm(x)) >= 15}
    kept: list[str] = []
    for i, line in enumerate(lines):
        s = line.strip()
        nxt = lines[i + 1].strip() if i + 1 < len(lines) else ""
        if (_QUOTE_START.match(s) or _SIGNATURE.match(s)
                or (_WROTE_START.match(s) and (_WROTE.search(s) or _WROTE.search(f"{s} {nxt}")))
                or (_HEADER.match(s) and _HEADER_NEXT.match(nxt))):
            break
        if s.startswith(">") or _FOOTER.match(s) or _norm(s) in sent:
            continue
        kept.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(kept)).strip()


def preview(body: str | None, ours: str | None = None, limit: int = 100) -> str:
    """What the person wrote, without the greeting line, on one line."""
    parts = [p.strip() for p in strip_quoted(body, ours).split("\n\n") if p.strip()]
    if len(parts) > 1 and _GREETING.match(parts[0]):
        parts = parts[1:]
    text = " ".join(" ".join(parts).split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


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
    (STRONG_NO, rf"{_NOT}( [\w']+){{0,3}} interested"),
    (STRONG_NO, r"no interest"),
    (STRONG_NO, r"no,? thank(s| you)"),
    (STRONG_NO, r"(we're|we are|i'm|i am) (all set|good for now|covered)"),
    (STRONG_NO, r"not (a|the) (good |right )?fit"),
    (STRONG_NO, r"(not|aren't|are not|isn't|is not) (looking|in the market) for"),
    (STRONG_NO, r"already (have|use|using|work with|working with|partner with)"),
    (STRONG_NO, r"(decided|chose|chosen) (to go with|another|against)"),
    (STRONG_NO, r"(no|zero) (budget|need|bandwidth)"),
    (STRONG_NO, r"please don't(?! hesitate)"),  # "please don't hesitate to reach out" is a sign-off
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
    (STRONG_YES, r"(love|like) (a|an|to see a|to get a|to book a) (quick |short )?(demo|call|chat|meeting|intro)"),
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
# Polite words, not a no: dropped when the reply also has a clear yes ("Unfortunately I missed your email - yes, let's
# talk!"). Without a clear yes they still count ("Unfortunately the timing is wrong").
_HEDGES = ("unfortunately",)

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
    if any(h["weight"] == STRONG_YES for h in hits):
        hits = [h for h in hits if h["phrase"] not in _HEDGES]
    score = min(1.0, max(0.0, NEUTRAL + sum(h["weight"] for h in hits)))
    return {"score": round(score, 2), "hits": hits, "question": bool(_QUESTION.search(text))}
