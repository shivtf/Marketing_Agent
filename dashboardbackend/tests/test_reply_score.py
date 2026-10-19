"""The keyword score (app/reply_rules.py score_reply) and how it sorts a reply on Positive Leads (app/data.py _judge)."""

import pytest

from app import data
from app.gmail import html_to_text
from app.reply_rules import NEUTRAL, score_reply, strip_quoted


def _phrases(text):
    return [h["phrase"] for h in score_reply(text)["hits"]]


@pytest.mark.parametrize(("text", "score"), [
    ("Thanks, sounds interesting. Can you send me the details?", 0.9),  # +0.25 +0.15
    ("Sounds good, send me times.", 1.0),  # capped at 1
    ("Yes, let's talk next week.", 0.75),
    ("Count me in.", 0.75),
    ("Sounds interesting.", 0.65),  # interest, but no step forward
    ("Maybe, depends on timing.", NEUTRAL),  # nothing matched
    ("Not now.", 0.3),
    ("No thanks.", 0.2),
    ("We already work with an agency, thanks for reaching out.", 0.2),
    ("", NEUTRAL),
    (None, NEUTRAL),
])
def test_scores(text, score):
    assert score_reply(text)["score"] == score


@pytest.mark.parametrize("text", ["I'm not interested.", "We wouldn't be interested.", "No longer interested",
                                  "I am not really interested", "I’m not interested"])
def test_a_no_never_counts_as_interested(text):
    result = score_reply(text)
    assert result["score"] < 0.5 and all(h["weight"] < 0 for h in result["hits"])


def test_a_strong_phrase_is_not_counted_again_by_a_weaker_one():
    # "I'm interested" (+0.25) must not also count the weak "interested" (+0.15).
    assert _phrases("I'm interested.") == ["i'm interested"]


@pytest.mark.parametrize(("text", "phrase", "weight"), [
    ("Hi Alex,\n\nSure.\n\nThanks", "sure", 0.25),
    ("Interested!", "interested", 0.25),
    ("No.", "no", -0.3),
])
def test_one_word_replies(text, phrase, weight):
    assert score_reply(text)["hits"] == [{"phrase": phrase, "weight": weight}]


def test_one_word_lines_in_a_long_reply_do_not_count():
    long = "Sure.\n\n" + "We have been reviewing our plans for the coming year with the whole team and will see. " * 2
    assert "sure" not in _phrases(long)


@pytest.mark.parametrize(("text", "question"), [
    ("What does it cost?", True),
    ("Send me your pricing", True),
    ("Yes, let's talk.", False),
])
def test_questions(text, question):
    assert score_reply(text)["question"] is question


# ---------- Where an unlabelled reply goes ----------


@pytest.mark.parametrize(("text", "group", "reason"), [
    ("Thanks, sounds interesting. Can you send me the details?", "positive", None),  # 0.9 beats the question
    ("What does it cost?", "questions", None),
    ("No thanks.", "notInterested", None),
    ("Not now.", "notInterested", None),
    ("Sounds interesting.", "review", "Score 0.65: no clear yes or no"),
    ("Maybe, depends on timing.", "review", "No keywords matched"),
    ("Not right now, but let's talk in Q2", "review", "Score 0.55: says both yes and no"),
    ("Not interested, why would I pay for this?", "notInterested", None),  # a question that says no is a no
])
def test_unlabelled_reply_is_sorted_by_its_score(text, group, reason):
    got, why, scored = data._judge(None, False, text)
    assert (got, why) == (group, reason) and scored == score_reply(text)


def test_a_persons_label_wins_over_the_score():
    group, why, scored = data._judge("not_interested", True, "Yes, let's talk!")
    assert (group, why) == ("notInterested", None) and scored["score"] == 0.75  # the score is still shown


def test_the_unsubscribe_rule_comes_before_the_score():
    assert data._judge(None, False, "Yes, let's talk. Also remove me from your list")[0] == "unsubscribe"


# ---------- What the person wrote (reply_rules.strip_quoted), then how the reply is judged ----------

OURS = ("Hi Priya,\n\nWe help teams like yours ship faster. Interested in a quick call to see if it fits?\n"
        "Let's talk next week.\n\nShivam\n\nUnsubscribe: https://unsub.example/u/123")


def _group(body, ours=OURS):
    return data._judge(None, False, strip_quoted(body, ours))[0]


@pytest.mark.parametrize(("body", "group"), [
    # Outlook: "From:" with a name only, then "Sent:"; our email follows unquoted (with its unsubscribe footer).
    ("Sounds good, let's talk.\n\n________________________________\nFrom: Shivam Bhandari\nSent: Monday, October 19, 2026"
     "\nTo: Priya\nSubject: Hello\n\n" + OURS, "positive"),
    ("Sounds good, let's talk.\n\nFrom: Shivam Bhandari\nSent: Monday, October 19, 2026\n\n" + OURS, "positive"),
    # Gmail wraps a long "On ... wrote:" line.
    ("Thanks but no thanks.\n\nOn Mon, Oct 19, 2026 at 10:00 AM Shivam Bhandari <\nshivam@us.test> wrote:\n\n" + OURS,
     "notInterested"),
    # Other languages.
    ("Not interested, thanks.\n\nAm Mo., 19. Okt. 2026 um 10:00 Uhr schrieb Shivam <s@us.test>:\n" + OURS, "notInterested"),
    ("Not interested.\n\nLe lun. 19 oct. 2026 à 10:00, Shivam <s@us.test> a écrit :\n" + OURS, "notInterested"),
    # Signature and sign-offs.
    ("Yes, let's set up a call on Tuesday.\n\nPlease don't hesitate to reach out.\n--\nJo", "positive"),
    ("Not now.\n\nSent from my iPhone\n\nOn 19 Oct 2026, at 10:00, Shivam <s@us.test> wrote:\n\n" + OURS, "notInterested"),
    # Their company's footer is not a request from them.
    ("Sure, send me the deck.\n\nJo Smith | ACME\nTo unsubscribe from ACME marketing emails, click here.", "positive"),
    # Lines of our email pasted back without any quote marker are left out too.
    ("Yes please.\n\n" + OURS, "positive"),
])
def test_quoted_mail_and_footers_are_not_scored(body, group):
    assert _group(body) == group
    if "Yes please" not in body:  # also without our email to compare with: the quote's first line is enough
        assert _group(body, None) == group


def test_a_real_unsubscribe_still_counts():
    assert _group("Please unsubscribe me.\n\nOn Mon, Shivam wrote:\n> " + OURS) == "unsubscribe"
    assert _group("Unsubscribe me please") == "unsubscribe"
    assert _group("Remove me from your list.") == "unsubscribe"


@pytest.mark.parametrize(("text", "group"), [
    ("Please remove me from this thread and loop in Raj instead.", "review"),
    ("Would love a demo. Can you do Friday?", "positive"),
    ("I'm not sure we'd be interested right now.", "notInterested"),
    ("Unfortunately I missed your first email - yes, let's talk!", "positive"),
    ("Unfortunately the timing is wrong for us.", "notInterested"),
])
def test_phrases_found_in_real_replies(text, group):
    assert _group(text, None) == group


def test_html_quotes_become_quoted_lines():
    html = ("<div dir=ltr>No thanks.</div><div class=gmail_quote><blockquote>Interested in a call?<br>"
            "<blockquote>older</blockquote></blockquote></div><p>after</p>")
    assert html_to_text(html) == "No thanks.\n\n> Interested in a call?\n\n> > older\n\nafter"
    assert strip_quoted(html_to_text(html)) == "No thanks.\n\nafter"
