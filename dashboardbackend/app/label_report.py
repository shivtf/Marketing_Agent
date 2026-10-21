"""Where the keyword score and a person's label disagree, to tune the keywords in app/reply_rules.py.

Every reply a person labelled on Positive Leads is judged again by the keywords alone (as if nobody had labelled it),
and each one where the keywords would put it in another group is listed with the phrases that matched. A good reply the
keywords would close as Not interested ("missed") is the costly kind, so those come first.

Run from dashboardbackend/, with the same DATABASE_URL as the backend (read only: it only selects):
    python -m app.label_report            # every disagreement
    python -m app.label_report --limit 20 # the first 20
"""

import argparse
import asyncio
import os

from dotenv import load_dotenv

from app.data import _judge
from app.reply_rules import strip_quoted

# A person's label -> the group it puts a reply in (ooo / bounce are not on Positive Leads).
LABEL_GROUP = {"interested": "positive", "question": "questions", "not_interested": "notInterested",
               "unsubscribe": "unsubscribe"}
# A reply the person kept open that the keywords would close: the costly mistake.
OPEN = ("positive", "questions", "unsubscribe")

_SQL = """
select s.id, s.from_email, s.received_at, s.body, e.body as sent_body, hl.label, hl.labelled_by
from reply_labels hl
join inbox_replies s on hl.source = 'inbox' and s.id = hl.reply_id
left join emails e on e.id = s.email_id
where hl.label = any($1::text[])
order by s.received_at desc
"""


def disagreements(rows: list[dict]) -> dict:
    """Labelled replies -> { total, agree, missed: [...], other: [...] }. Each item: { id, from, label group, keyword
    group, reason, hits, text }. missed: a person kept it open (positive / questions / unsubscribe) but the keywords
    would close it as notInterested, or a person said unsubscribe and the keywords didn't see it."""
    out = {"total": 0, "agree": 0, "missed": [], "other": []}
    for r in rows:
        want = LABEL_GROUP.get(r["label"])
        if not want:
            continue
        out["total"] += 1
        text = strip_quoted(r["body"], r["sent_body"])
        got, why, scored = _judge(None, False, text)
        if got == want:
            out["agree"] += 1
            continue
        item = {"id": str(r["id"]), "from": r["from_email"], "labelled": want, "keywords": got, "reason": why,
                "score": scored["score"], "hits": scored["hits"], "text": " ".join(text.split())[:300]}
        missed = (want in OPEN and got == "notInterested") or (want == "unsubscribe" and got != "unsubscribe")
        out["missed" if missed else "other"].append(item)
    return out


def _print(report: dict, limit: int | None) -> None:
    total, agree = report["total"], report["agree"]
    if not total:
        print("No labelled replies yet: label some on Positive Leads first.")
        return
    print(f"{total} labelled replies: the keywords agree on {agree} ({agree / total:.0%}), "
          f"{len(report['missed'])} missed, {len(report['other'])} other disagreements.\n")
    items = [("MISSED", i) for i in report["missed"]] + [("DIFFERENT", i) for i in report["other"]]
    for kind, i in items[:limit]:
        hits = ", ".join(f"“{h['phrase']}” {h['weight']:+.2f}" for h in i["hits"]) or "no keywords matched"
        print(f"[{kind}] person: {i['labelled']}  keywords: {i['keywords']}  (score {i['score']:.2f}; {hits})")
        if i["reason"]:
            print(f"  why: {i['reason']}")
        print(f"  {i['from']}: {i['text']}\n")


async def _main(limit: int | None) -> None:
    import asyncpg

    load_dotenv()
    dsn = os.environ.get("DATABASE_URL", "").strip()
    if not dsn:
        raise SystemExit("DATABASE_URL is not set (dashboardbackend/.env).")
    conn = await asyncpg.connect(dsn, statement_cache_size=0)
    try:
        rows = [dict(r) for r in await conn.fetch(_SQL, list(LABEL_GROUP))]
    finally:
        await conn.close()
    _print(disagreements(rows), limit)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--limit", type=int, default=None, help="show at most this many")
    asyncio.run(_main(parser.parse_args().limit))
