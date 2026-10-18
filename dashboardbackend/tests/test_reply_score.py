"""The keyword score (app/reply_rules.py score_reply) and how it sorts a reply on Positive Leads (app/data.py _judge)."""

import pytest

from app import data
from app.reply_rules import NEUTRAL, score_reply


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
