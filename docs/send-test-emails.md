# Send these test emails

Ready-to-copy emails for testing Positive Leads with the test lead. Send them **in order, one at a time**, and click
**Check inbox** on Positive Leads after each one. Every email adds its own row in its group; the earlier rows stay,
and their follow-up changes to **Wrote again**. The top cards count leads, so Test Lead counts once however many
emails they send. They count as positive after a positive email until they say no (Not interested or Unsubscribe).

The full explanation and more cases are in [test-emails.md](test-emails.md).

## Every email

- **From:** `shivam714bhandari@gmail.com` (the test lead)
- **To:** the Gmail inbox connected on the History page (`shivambhandari090@gmail.com`, if it is still that one)
- A **new email** is fine; it does not have to be a reply. You do not need to send anything from the connected Gmail
  first: the test lead's "sent" email exists in the database.
- Inbox or archived both work (not spam or trash).

Do not send from the connected Gmail: mail sent by that account counts as our own and is ignored.

## 1. Positive

**Subject:** Re: Dashboard test

```
Hi,

Sounds great, send me some times for a call next week.

Thanks
```

**Expect:** Positive · Score **1.00** · Why Here: “send me some times” +0.25, “sounds great” +0.25 ·
Follow-up: Waiting · today

## 2. Questions

**Subject:** Re: Dashboard test

```
Hi,

What does it cost?

Thanks
```

**Expect:** Questions · Score **0.50** · Why Here: No keywords matched

## 3. Needs review (yes and no)

**Subject:** Re: Dashboard test

```
Hi,

Not right now, but let's talk in Q2.

Thanks
```

**Expect:** Needs review · Score **0.55** · Why Here: Score 0.55: says both yes and no

## 4. Needs review (no clear answer)

**Subject:** Re: Dashboard test

```
Hi,

Sounds interesting.

Thanks
```

**Expect:** Needs review · Score **0.65** · Why Here: Score 0.65: no clear yes or no

Then, in the drawer, choose **Interested** and Save → this email's row moves to **Positive** and Why Here says
"Labelled by a person". Click **Remove** → back to Needs review. A label belongs to one email only; the other rows are
not affected.

## 5. Not interested

**Subject:** Re: Dashboard test

```
Hi,

No thanks, we already work with an agency.

Thanks
```

**Expect:** Not interested · Score **0.00** · Why Here: “no thanks” −0.30, “already work with” −0.30 ·
Follow-up: No answer needed

## 6. Unsubscribe

**Subject:** Re: Dashboard test

```
Hi,

Please remove me from your list.

Thanks
```

**Expect:** Unsubscribe · Why Here: It seems to ask not to be contacted again

## 7. Back to positive

**Subject:** Re: Dashboard test

```
Hi,

Actually, yes, let's talk. I'm interested.

Thanks
```

**Expect:** Positive · Score **1.00** · Why Here: “let's talk” +0.25, “i'm interested” +0.25

## If something does not match

Send the exact message under the Check inbox button ("Checked N emails in Gmail since …") and a screenshot of the
row. The expected results above come from running each email through the real scoring code.

When you are done, run the clean-up SQL at the end of [test-emails.md](test-emails.md).
