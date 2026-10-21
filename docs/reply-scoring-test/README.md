# Testing the reply keywords (Positive Leads)

A test of the new keyword rules (branch `fix/reply-scoring`, `dashboardbackend/app/reply_rules.py`) with real mail:
one EV charger outreach email to a test lead, then 33 replies from that lead, each with the group it should land in.

- [sender-mail.md](sender-mail.md): the outreach email the test lead receives.
- [receiver-mails.md](receiver-mails.md): the replies to send back (R01–R33) and the expected group of each.

## You need

- The backend from `fix/reply-scoring` running (locally or on Render) and the dashboard pointing at it.
- Gmail connected on the History page (the outreach mailbox).
- A **second mailbox you own** as the test lead, e.g. a spare Gmail. Not the connected inbox: mail from it counts as
  our own and is skipped.

## Steps

1. **Make the test lead.** A contact with your test address, for a test company. For example, on Needs Contact, add
   the test address to a company waiting for one (or make one in the agent the usual way).
2. **Send the sender mail through the Marketing Agent**, so it is saved in the `emails` table with status `sent`.
   Approve it in Slack as usual. A mail typed by hand in Gmail is not enough: the dashboard only counts a reply that
   answers one of the agent's recorded emails (by its Message-ID, its Gmail conversation, or a lead's address).
3. **Reply from the test address.** For each of R01–R33 in [receiver-mails.md](receiver-mails.md), press Reply on the
   sender mail and paste the text in the box (send them a minute apart, in order). R33 needs its subject changed; see
   its note.
4. **Read them in.** Open Positive Leads and click **Check inbox** (it also runs when the page opens, at most every 5
   minutes).
5. **Compare.** Each reply should be in the group the table says, with the reason shown under Why Here for Needs
   review and Unsubscribe. Open a row: the drawer shows the score and the phrases that matched (a negated one looks
   like `"can't … schedule a call" −0.20`).

Things that are expected, not bugs:

- Under Follow-up, the rows in Not interested show **No answer needed**, the newest listed reply (R32) shows
  **Waiting**, and every other row shows **Wrote again**: the lead wrote again since, so only their newest reply is
  waiting for an answer.
- The stat cards count **leads**, so the test lead counts once.
- The Unsubscribe replies (R30–R32) are only listed: the agent keeps emailing the test address until a person labels
  one of them Unsubscribe in its drawer. **Don't label them** if the agent should email the test address again; if you
  did, choose another label (or Remove) on the same reply, which takes the address off the do-not-email list again.

## Check a reply without sending it

To see where any text would land, from `dashboardbackend/`:

```
.venv/bin/python -c "import sys; from app.data import _judge; g, why, s = _judge(None, False, sys.argv[1]); print(g, '|', why, '|', s['score'], s['hits'])" "Too busy this week. Next week?"
```

## Label vs keywords

After people have labelled some real replies, this lists where the keywords and the labels disagree (read only):

```
cd dashboardbackend && .venv/bin/python -m app.label_report --limit 30
```

## Cleaning up afterwards

The test replies stay in `inbox_replies` and keep the test lead as Responded. To remove them:

1. **First delete the test mails in Gmail** (from the connected inbox; move them to Trash). Otherwise the next inbox
   check reads them again: a reply whose saved row was deleted is read again on purpose.
2. Then, in the Supabase SQL editor (replace the address):

   ```sql
   delete from reply_labels where source = 'inbox'
     and reply_id in (select id from inbox_replies where from_email = 'your-test-address@example.com');
   delete from inbox_replies where from_email = 'your-test-address@example.com';
   ```

The test lead itself (contact, company, the agent's email) belongs to the Marketing Agent's tables: remove it there.
