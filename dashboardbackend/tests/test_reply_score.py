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
    ("Not now.", "review", "Score 0.30: only a soft no (it may mean later)"),  # one soft no never closes a reply
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
    ("Not now.\n\nSent from my iPhone\n\nOn 19 Oct 2026, at 10:00, Shivam <s@us.test> wrote:\n\n" + OURS, "review"),
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


# ---------- Wording that used to land in the wrong group (2026-10-21 review) ----------
# Each one was misread before: "I'm in a meeting" was Positive, "Too busy this week. Next week?" was closed as Not
# interested, "No more emails please" was not flagged.


@pytest.mark.parametrize(("text", "group"), [
    # Phrases that matched ordinary sentences.
    ("I'm in a meeting all day, will read this later.", "review"),
    ("We're in the middle of a migration, so timing is bad.", "review"),
    ("My calendar is completely full until March.", "review"),
    ("Ok.", "review"),  # often only "noted"
    ("Learn more at acme.io | Privacy policy", "review"),
    # A yes phrase after a negation is not a yes.
    ("Don't send me more info, we are not buying.", "notInterested"),
    ("We can't schedule a call this quarter.", "review"),
    ("Not great timing for us.", "review"),
    # A no phrase that is often not a no.
    ("We already use Jenkins and it's painful, how would you help us migrate?", "questions"),
    ("I already have your deck, let's talk Tuesday.", "positive"),
    ("No need to apologize! Happy to hear more.", "positive"),
    ("Please don't worry about the delay, send me the pricing.", "positive"),
    ("I've never been more interested in a tool like this.", "positive"),
    ("Not at this conference, sorry, but let's connect online.", "positive"),
    # A soft no about this week is not a no.
    ("Unfortunately I'm traveling this week, can we talk next week?", "positive"),
    ("Too busy this week. Next week?", "review"),
    # Annoyed questions are not a buyer's questions.
    ("Who is this? How did you get my email?", "notInterested"),
    ("Hello, who is this?", "questions"),  # may be honest curiosity: answer it
    # Someone else should get the next email.
    ("You should talk to my colleague Priya, she owns CI.", "review"),
    # Asks to stop.
    ("No more emails please.", "unsubscribe"),
    ("Please remove this address from your mailing list.", "unsubscribe"),
    ("Please don't email again.", "unsubscribe"),
])
def test_wording_that_was_misread(text, group):
    assert _group(text, None) == group


@pytest.mark.parametrize(("text", "group"), [
    # Wants to meet.
    ("Does Thursday work for a quick chat?", "positive"),
    ("How about Tuesday afternoon?", "positive"),
    ("I'm free on Friday, send an invite.", "positive"),
    ("We're available next week.", "positive"),
    ("Happy to jump on a Zoom.", "positive"),
    ("Here's my calendly: calendly.com/jo/30min", "positive"),
    ("I'm in!", "positive"),
    ("I can't wait to see the demo.", "positive"),
    ("Why not schedule a call next week?", "positive"),
    # Wants information.
    ("Can you send over some case studies?", "positive"),
    ("What are your rates?", "questions"),
    ("How much would this cost for a team of 10", "questions"),
    # Interested, but later.
    ("Reach out to us again in Q1.", "review"),
    ("Let's circle back after the holidays.", "review"),
    ("Maybe next quarter.", "review"),
    ("Ping me in a couple of months.", "review"),
    # Referral.
    ("I'm not the right person, cc'ing our CTO.", "review"),
    ("Looping in Raj who runs our platform team.", "review"),
    # Polite no.
    ("We'll pass, thanks.", "notInterested"),
    ("Not for us.", "notInterested"),
    ("We've decided to go with another vendor.", "notInterested"),
    ("Our budget is frozen and there's a hiring freeze.", "notInterested"),
    ("We already work with another agency.", "notInterested"),
    ("Unfortunately the timing is wrong for us.", "notInterested"),  # two soft nos
    ("We're all set, no need for this.", "notInterested"),
    # Asks to stop.
    ("Stop spamming me.", "unsubscribe"),
    ("Take me off your list.", "unsubscribe"),
    ("Under GDPR, please delete my data.", "unsubscribe"),
    ("Leave us alone.", "unsubscribe"),
    ("Please do not reach out again.", "unsubscribe"),
    ("Don't reach out to me again.", "unsubscribe"),
    # Someone else's list: a no, not a request to stop.
    ("We had to remove you from the list of vendors we're considering.", "review"),
    # Unchanged: one soft no still isn't a yes or a no.
    ("Not now.", "review"),
])
def test_keyword_families(text, group):
    assert _group(text, None) == group


def test_a_negated_yes_is_shown_as_a_soft_no():
    hits = score_reply("We can't schedule a call this quarter.")["hits"]
    assert hits == [{"phrase": "can't … schedule a call", "weight": -0.2}]


def test_a_soft_no_alone_says_why_it_needs_review():
    assert data._judge(None, False, "Not right now.")[1] == "Score 0.30: only a soft no (it may mean later)"
    assert data._judge(None, False, "Ping me in a couple of months.")[1] == "Asks to be contacted later"
    assert data._judge(None, False, "Looping in Raj.")[1] == "Points you to someone else: write to them"


# ---------- Label vs keywords (app/label_report.py) ----------


def test_label_report_lists_where_keywords_and_people_disagree(capsys):
    from app import label_report

    def row(id_, label, body):
        return {"id": id_, "from_email": f"{id_}@lead.test", "body": body, "sent_body": None, "label": label}

    report = label_report.disagreements([
        row("a", "interested", "Yes, let's talk."),  # agree
        row("b", "interested", "Unfortunately the timing is wrong, but call me on the 28th."),  # closed by keywords
        row("c", "unsubscribe", "Kindly stop."),  # not seen by keywords
        row("d", "not_interested", "Sounds interesting."),  # keywords: review
        row("e", "ooo", "Away."),  # not on Positive Leads: skipped
    ])
    assert (report["total"], report["agree"]) == (4, 1)
    assert [i["id"] for i in report["missed"]] == ["b", "c"]
    assert [(i["id"], i["labelled"], i["keywords"]) for i in report["other"]] == [("d", "notInterested", "review")]
    label_report._print(report, None)
    out = capsys.readouterr().out
    assert "4 labelled replies: the keywords agree on 1 (25%), 2 missed, 1 other" in out
    assert "[MISSED] person: positive  keywords: notInterested" in out
