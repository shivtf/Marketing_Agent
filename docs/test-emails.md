# Test emails for Positive Leads

Emails to send as a lead, and what the dashboard should show for each. Use them to check that the backend reads
replies from Gmail and sorts them by their keyword score.

Every result below was produced by running the email through the real code (`score_reply()` in
`dashboardbackend/app/reply_rules.py` and `_judge()` in `dashboardbackend/app/data.py`). If the page shows something
else, that is a bug.

## How it works, in short

1. A lead emails the connected Gmail inbox.
2. When someone opens Positive Leads (at most once every 5 minutes), clicks **Check inbox**, or the backend's own
   check runs (every `INBOX_CHECK_EVERY_MINUTES`, when that is set), the backend reads the new mail (archived mail
   too) and keeps only mail from leads we emailed. Quoted earlier mail, the signature and footers are left out.
3. Each reply gets a score: it starts at **0.50**, and each phrase found adds or takes away points
   (strong yes **+0.25**, soft yes **+0.15**, soft no **−0.20**, strong no **−0.30**).
4. Every reply is its own row on the page, judged on its own words. A lead's new email adds a row; their older
   emails stay where they are. Each reply goes to a group:

| Check, in this order | Group |
|---|---|
| A person chose a label in the drawer | that label, always |
| It asks to unsubscribe / stop | Unsubscribe |
| It says both yes and no | Needs review |
| Score 0.70 or more | Positive |
| It asks a question and says no "no" | Questions |
| Score below 0.40 | Not interested |
| Anything else (0.40 – 0.70) | Needs review |

## Before you start

1. Be on `main` with the latest code: `git checkout main && git pull` (the feature arrived in PR #8).
2. Start the backend and the dashboard from `~/Marketing_Agent`:
   ```bash
   cd ~/Marketing_Agent/dashboardbackend && source .venv/bin/activate && uvicorn app.main:app --reload --port 8000
   cd ~/Marketing_Agent/dashboard && npm run dev
   ```
3. Gmail is connected on the History page.
4. Create the test lead: run this in the Supabase SQL editor (nothing to fill in). Its company is `REJECTED`, so the
   agent ignores it; the dashboard still shows it because it lists every contact we emailed.
   ```sql
   with co as (
     insert into companies (name, domain, source, lead_status)
     values ('Dashboard Test Co', 'dashboard-test.invalid', 'leadgen:test', 'REJECTED')
     returning id
   ), ct as (
     insert into contacts (company_id, name, email, source_url)
     select id, 'Test Lead', 'shivam714bhandari@gmail.com', 'https://dashboard-test.invalid' from co
     returning id
   )
   insert into emails (contact_id, campaign_id, step, status, subject, mailbox, sent_at, idempotency_key)
   select ct.id, (select campaign_id from emails limit 1), 1, 'sent', 'Dashboard test',
          'shivambhandari090@gmail.com', now(), 'dashboard-test-' || gen_random_uuid()
   from ct
   returning id;
   ```

## How to send each test

1. From **shivam714bhandari@gmail.com**, send the email to the connected Gmail (a new email is fine; it does not have
   to be a reply, and nothing has to be sent from the connected Gmail first). Do not send from the connected address
   itself: that counts as our own mail. Ready-to-copy versions: [send-test-emails.md](send-test-emails.md).
2. Inbox or archived both work (spam and trash are not read).
3. On Positive Leads click **Check inbox**. The message should say `Checked N emails in Gmail since …: 1 new reply from
   leads.`
4. Find **Test Lead** in the group below and check the **Why Here** column, then open the drawer and check the
   **Keyword Score** row.

Send one at a time and check it before sending the next. Every email adds its own row, so the earlier ones stay
on the page; their follow-up changes to **Wrote again** (the newest email is the one waiting for an answer).

## The emails and the expected result

### Positive (score 0.70 or more)

| # | Email | Score | Why Here shows |
|---|---|---|---|
| 1 | Thanks, sounds interesting. Can you send me the details? | 0.90 | “send me the details” +0.25, “sounds interesting” +0.15 |
| 2 | Sounds great, send me some times for a call next week. | 1.00 | “send me some times” +0.25, “sounds great” +0.25 |
| 3 | Hi, (new line) Yes, let's talk. I'm interested. (new line) Best, Test | 1.00 | “let's talk” +0.25, “i'm interested” +0.25 |
| 4 | Sure. | 0.75 | “sure” +0.25 |
| 5 | Count me in. | 0.75 | “count me in” +0.25 |
| 6 | Happy to chat. What time works for you on Thursday? | 1.00 | “happy to chat” +0.25, “what time works” +0.25 (a question, but 0.70+ wins) |

### Questions

| # | Email | Score | Why Here shows |
|---|---|---|---|
| 7 | What does it cost? | 0.50 | No keywords matched |
| 8 | How does it work with our existing setup? | 0.50 | No keywords matched |
| 9 | Who is this? | 0.50 | No keywords matched |
| 10 | Interested, but what would it cost? | 0.65 | “interested” +0.15 |

### Needs review

| # | Email | Score | Why Here shows |
|---|---|---|---|
| 11 | Sounds interesting. | 0.65 | Score 0.65: no clear yes or no |
| 12 | Maybe, depends on timing. | 0.50 | No keywords matched |
| 13 | Not right now, but let's talk in Q2. | 0.55 | Score 0.55: says both yes and no |

### Not interested (score below 0.40)

| # | Email | Score | Why Here shows |
|---|---|---|---|
| 14 | No thanks. | 0.20 | “no thanks” −0.30 |
| 15 | We already work with an agency, thanks for reaching out. | 0.20 | “already work with” −0.30 |
| 16 | Not interested. | 0.20 | “not interested” −0.30 |
| 17 | Not now. | 0.30 | “not now” −0.20 |
| 18 | Unfortunately this is not a priority for us. | 0.10 | “not a priority” −0.20, “unfortunately” −0.20 |
| 19 | Not interested, why would I pay for this? | 0.20 | “not interested” −0.30 (a question that says no is a no) |

Follow-up shows **No answer needed** for this group.

### Unsubscribe

| # | Email | Score | Why Here shows |
|---|---|---|---|
| 20 | Please remove me from your list. | 0.50 | It seems to ask not to be contacted again |
| 21 | Stop emailing me. | 0.50 | It seems to ask not to be contacted again |

The dashboard does not stop the agent's emails; an unsubscribe still has to be handled in the mail agent.

## Other things to test

| Test | How | Expected |
|---|---|---|
| A person's label wins | Send #11 (Needs review), open the drawer, choose **Interested**, Save | Moves to Positive; Why Here says "Labelled by a person"; the drawer still shows Score 0.65 and "A person's label is used instead" |
| Remove the label | In the drawer, click **Remove** | Back to Needs review |
| Every email stays | Send #2 (Positive), check, then send #14 (Not interested), check | Two rows for Test Lead: #2 stays in Positive (follow-up **Wrote again**), #14 is added to Not interested. The Positive Leads card goes down by one: a lead counts by their latest email |
| We replied | Reply to the test lead's email from the connected Gmail, then click Check inbox | Follow-up shows **We replied** with the date |
| Waiting | Any Positive reply we have not answered | Follow-up shows **Waiting · today**, red after 3 days |
| Already read | Click Check inbox twice | The second check says "no new replies from leads" |
| A lost reply comes back | In Supabase: `delete from inbox_replies where contact_id in (select c.id from contacts c join companies co on co.id = c.company_id where co.domain = 'dashboard-test.invalid');` then Check inbox | The reply is read again and the lead reappears |
| Our own mail is ignored | Send an email from the connected Gmail to itself | Not shown anywhere on Positive Leads |
| Mail from a stranger is ignored | Send from an address that is not a contact | Not shown anywhere on Positive Leads |

## Known limits

- Spam and trash are not read. Archived replies and replies under a label are.
- A new email from a lead's address is matched only if we sent that lead an email with status `sent`.
- Without `INBOX_CHECK_EVERY_MINUTES` on the backend, new mail is read only when Positive Leads is opened or Check
  inbox is clicked.
- Replies in a language other than English are not scored (no keywords match): they go to Needs review.

## Clean up afterwards

Run in the Supabase SQL editor:

```sql
delete from reply_labels where source = 'inbox' and reply_id in (
  select s.id from inbox_replies s join contacts c on c.id = s.contact_id
  join companies co on co.id = c.company_id where co.domain = 'dashboard-test.invalid');
delete from inbox_replies where contact_id in (
  select c.id from contacts c join companies co on co.id = c.company_id where co.domain = 'dashboard-test.invalid');
delete from emails where contact_id in (
  select c.id from contacts c join companies co on co.id = c.company_id where co.domain = 'dashboard-test.invalid');
delete from contacts where company_id in (select id from companies where domain = 'dashboard-test.invalid');
delete from companies where domain = 'dashboard-test.invalid';
```
