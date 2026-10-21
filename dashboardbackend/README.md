# Dashboard backend

Python (FastAPI) API for the dashboard. Sign-in, sign-out and password reset stay with Supabase Auth
(the browser talks to it directly); this service verifies the Supabase access token on every protected call.

| Route                                                      | Auth   | Purpose                                      |
|------------------------------------------------------------|--------|----------------------------------------------|
| `GET /health`                                              | none   | liveness                                     |
| `GET /auth/me`                                             | Bearer | returns `id`, `email` and the dashboard `role` (admin / employee) |
| `GET /leads`, `/leads/stats`, `/leads/positive`, `/leads/{id}`, `/leads/by-reply/{id}` | Bearer | leads, counts, every reply written by a person in its group (one row each), one lead, one lead with one of its replies |
| `GET /needs-contact`, `POST /needs-contact/{id}/contact` | Bearer | qualified leads with no contact; save an email for one (the only lead write, SQL `submit_manual_contact()`) |
| `GET /emails/sent`, `/emails/sent/{id}`                    | Bearer | sent emails                                  |
| `GET /emails/replies/{id}`                                 | Bearer | one reply read from Gmail, with the email it answers |
| `GET /blogs`, `/blogs/{id}`                                | Bearer | blog posts and their publish status          |
| `POST /inbox/check`, `POST /inbox/label`                 | Bearer | read new replies from the connected Gmail inbox (read only); a person's label for a reply, Unsubscribe also stops the mail agent emailing them (`app/inbox.py`) |
| `POST /blog-posts/post-today`, `POST /blog-posts/post-again` | Admin | post today's approved blogs to Dev.to; post a failed or missed one, up to 3 days late (`app/blog_posts.py`) |

Protect a new route with `user: dict = Depends(current_user)` (`app/auth.py`).

## How the data gets to the dashboard

```text
lead / outreach / content services ──write──▶ Supabase Postgres ◀──read-only── app/data.py ──JSON──▶ dashboard
```

1. The Marketing Agent (another repo) writes companies, contacts, emails and content posts to
   Supabase Postgres. This backend never writes to those tables, except through two narrow functions: adding a contact
   (below) and the do-not-email list (an Unsubscribe label, below).
   A company with no contact (`NEEDS_CONTACT`) gets its email from a person here: `POST /needs-contact/{id}/contact` calls
   the SQL function `submit_manual_contact()` (Marketing-AI-Agent migration `0013`), the agent drafts the email and posts the
   approval request to Slack. Nothing is sent from here.
   The mail agent only sends; it never reads replies. Every reply is read by this backend from Gmail
   (`POST /inbox/check`: the connected inbox, read only, matched to our emails) and stored in its own tables
   (migrations `007_inbox_replies.sql` and `008_inbox_indexes.sql`, run by hand, **required**), with the labels people
   give replies on Positive Leads. It needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (same values as the
   dashboard's) to read the Gmail access the dashboard saved. Every message except our sent mail, drafts and chats is
   read, archived ones too; one check reads up to 200 new messages. The check runs when Positive Leads is opened (at
   most every 5 minutes) or Check inbox is clicked, and on its own every N minutes when `INBOX_CHECK_EVERY_MINUTES` is
   set (e.g. `10` on Render; leave it unset locally unless you want the background check).
   On Positive Leads (`GET /leads/positive`) every reply written by a person is its own row, judged on what the person
   wrote: quoted earlier mail (Gmail, Outlook and other languages' "wrote:" lines, `>` lines, HTML quotes), the
   signature, mailing-list footers and lines copied from our email are left out (`strip_quoted()` in
   `app/reply_rules.py`). A person's label wins; otherwise the unsubscribe-wording rule and then a **keyword score** (`score_reply()` in
   `app/reply_rules.py`): it starts at 0.5, each phrase found adds its weight (a yes phrase after a negation, as in
   "we can't schedule a call", counts as a soft no), and **0.70 or more → Positive, 0.30–0.70 → Needs review, below
   0.30 → Not interested**. Only a clear no is closed as Not interested: a strong no ("not interested"), or soft nos
   that together score below 0.30. A reply with both a yes and a no, a single soft no ("not now"), or one asking to be
   contacted later or pointing to someone else goes to review, and a question goes to Questions; a strong no still
   closes those, two soft nos don't ("Too busy right now. Maybe next year?" goes to review). Edit the phrase list there to tune it;
   every reply is re-scored on the next page load (nothing is stored).
   **Unsubscribe:** when a person labels a reply Unsubscribe in its drawer, the reply's addresses (the sender and the
   lead) go on the mail agent's do-not-email list (`suppression_list`, which the agent checks before every send and
   follow-up), and the drawer then says so. Taking the label back lifts only what the dashboard added, never the
   agent's own entries (bounces, unsubscribe-link clicks). A reply only the keywords think asks to stop is listed under
   Unsubscribe but not added until a person labels it. Needs `migrations/012_unsubscribe_suppression.sql`, run by hand
   after 009: until then an Unsubscribe label is refused with a note saying so. To see where the keywords disagree with the
   labels people gave, run `python -m app.label_report` (read only, uses `DATABASE_URL`): each reply a person kept
   open but the keywords would close is listed first, with the phrases that matched.
2. The dashboard logs the user in with Supabase Auth and calls this API through `apiFetch()` in
   `dashboard/core/api.js`, sending `Authorization: Bearer <access_token>`.
3. Every route in `app/data.py` runs `current_user` first (`app/auth.py`), which verifies the token's
   signature and expiry. A missing or invalid token gets a `401`.
4. The route runs a SQL query over `DATABASE_URL` (asyncpg pool, created on first request).
   Queries join the tables into the dashboard's view of the data:
   - a **lead** is a `contacts` row joined to its `companies` row;
   - its **status** is `Responded` if it has a reply read from Gmail written by a person (matched by reply headers,
     the same conversation, or the lead's address; not out-of-office or bounce), then `Bounced`, `Sent` or `Not Sent`;
   - its **source** is `companies.source` without its prefix (`leadgen:feed:hn_hiring` -> `hn_hiring`), else `other`;
   - **sent emails** are `emails` with status `sent` or `bounced`; they show as Sent, or Failed when bounced (as the
     agent recorded it, or as a bounce notice read from Gmail says);
   - **blogs** are `content_posts`; `published` shows as Posted, anything else as Not Posted.
5. Rows are converted to camelCase JSON (`sent_at` becomes `sentAt`) so they match the shapes the
   dashboard expects. List routes leave out heavy fields
   (email and blog bodies); the `/{id}` routes include them.
6. There is no agent control here. The dashboard never starts or stops the Marketing Agent: the Campaign Agent does,
   and the dashboard pauses or resumes the Campaign Agent through its own Next.js routes (`dashboard/app/api/ca`).

To add a new data route, write a query in `app/data.py`, return it through `_rows()` / `_one()`, then add a
one-line `apiFetch()` function for it in `api.js`.

## Run

```bash
cd dashboardbackend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt   # the app's packages plus pytest and ruff (Render only needs requirements.txt)
# create .env with SUPABASE_URL and DATABASE_URL (the pooled Postgres connection string)
uvicorn app.main:app --reload --port 8000
python -m pytest   # the real-SQL tests (test_mail_sql, test_inbox_sql, test_role_sql) need Postgres: sudo apt install postgresql
ruff check .        # lint (the same check CI runs on every push)
```

Tokens are verified against the project's JWKS (`/auth/v1/.well-known/jwks.json`); set `SUPABASE_JWT_SECRET`
only for legacy HS256 projects. The dashboard sends `Authorization: Bearer <session.access_token>`.

## Database login

Use the limited `dashboard_backend` login, not the database owner: run `migrations/009_dashboard_backend_role.sql` once
in the Supabase SQL editor (after 006 and 007), set its password (`alter role dashboard_backend with login password
'...'`), and put the pooler URL with that user in `DATABASE_URL` (here and on Render). It can read the lead tables
(`companies`, `contacts`, `emails`, `content_posts`) and the saved Gmail connection, keep its own tables
(`dashboard_presence`, `inbox_replies`, `inbox_seen`, `reply_labels`), call `submit_manual_contact()`, and reach Supabase
Auth only through four narrow functions in that file. 012 adds the do-not-email functions (`dashboard_suppress()`,
`dashboard_unsuppress()`, `dashboard_is_suppressed()`): they act only on the addresses of a reply labelled unsubscribe,
and the login gets no rights on `suppression_list` itself. The backend needs 009 (applied on Supabase): the sign-in check
calls those functions, whichever login DATABASE_URL uses, so a new database must run 009 before the backend starts.

## Posting blogs (Dev.to)

The Marketing Agent no longer posts blogs; this backend does (`app/blog_posts.py`). The dashboard's own server writes
`blog_approval` (`migrations/010_blog_approval.sql`) with the service key when an admin approves or rejects a blog of a
weekly blog file. When an admin clicks **Post today's blogs** on the Blogs page, `POST /blog-posts/post-today` posts
every blog approved for today that isn't posted yet, as the copy that was approved, and records it in `blog_posts`
(`migrations/011_blog_posts.sql`). Each blog is claimed there as `posting` before Dev.to is called, and the claim checks
the approval again, so a blog is never posted twice and a blog taken back is skipped. A failed blog is not retried on
its own: an admin clicks **Post again** in the blog's window. Dev.to may have posted it even without an answer, so a
blog tried before is first looked for on Dev.to (same title, our latest 100 posts) and only recorded when it is already
there; the same happens for a blog left `posting` for 15 minutes (the server stopped, or the database refused to record
it after Dev.to took it). There
is no scheduled run yet: posting happens only on that click. A blog nobody posted on its day shows as **Missed**;
"Post now" (the same `post-again` call) can still post it, like a failed one, up to 3 days after its date (`LATE_DAYS`).
"Today" is India time everywhere (`BLOG_TIMEZONE` here, and the dashboard's `BLOG_TIMEZONE` in core/weeklyBlogs.js). The Blog Tracker (`GET /blogs`) lists the Marketing
Agent's old posts (`content_posts`) and these.

Run 010 and then 011 in the Supabase SQL editor **before** deploying (`GET /blogs` reads `blog_posts`). 011 lets
`dashboard_backend` read `blog_approval` (not write it) and keep `blog_posts`. Settings on Render:

| Variable        | Value |
|-----------------|-------|
| `BLOG_POSTING`  | `off` (default: nothing is posted), `draft` (Dev.to drafts, to test), `live` |
| `DEVTO_API_KEY` | from dev.to → Settings → Extensions → DEV Community API Keys |
| `BLOG_TIMEZONE` | which day is "today"; default `Asia/Kolkata` |

Every request is refused with 503 while the sign-in check cannot reach the database (never let through unchecked), so a
removed account or a second sign-in can't slip in during an outage.
