# Dashboard backend

Python (FastAPI) API for the dashboard. Sign-in, sign-out and password reset stay with Supabase Auth
(the browser talks to it directly); this service verifies the Supabase access token on every protected call.

| Route                                                      | Auth   | Purpose                                      |
|------------------------------------------------------------|--------|----------------------------------------------|
| `GET /health`                                              | none   | liveness                                     |
| `GET /auth/me`                                             | Bearer | returns `id`, `email`, `role` of the user    |
| `GET /leads`, `/leads/stats`, `/leads/positive`, `/leads/{id}` | Bearer | leads, counts, positive / review / question leads (latest human reply), one lead |
| `GET /needs-contact`, `POST /needs-contact/{id}/contact` | Bearer | qualified leads with no contact; save an email for one (the only lead write, SQL `submit_manual_contact()`) |
| `GET /emails/sent`, `/emails/sent/{id}`                    | Bearer | sent emails                                  |
| `GET /emails/replies/{id}`                                 | Bearer | one reply read from Gmail, with the email it answers |
| `GET /blogs`, `/blogs/{id}`                                | Bearer | blog posts and their publish status          |
| `POST /inbox/check`, `POST /inbox/label`                 | Bearer | read new replies from the connected Gmail inbox (read only); a person's label for a reply (`app/inbox.py`) |

Protect a new route with `user: dict = Depends(current_user)` (`app/auth.py`).

## How the data gets to the dashboard

```text
lead / outreach / content services ──write──▶ Supabase Postgres ◀──read-only── app/data.py ──JSON──▶ dashboard
```

1. The pipeline services (`services/*`) write companies, contacts, emails and content posts to
   Supabase Postgres. This backend never writes to those tables, except for the one function call below.
   A company with no contact (`NEEDS_CONTACT`) gets its email from a person here: `POST /needs-contact/{id}/contact` calls
   the SQL function `submit_manual_contact()` (Marketing-AI-Agent migration `0013`), the agent drafts the email and posts the
   approval request to Slack. Nothing is sent from here.
   The mail agent only sends; it never reads replies. Every reply is read by this backend from Gmail
   (`POST /inbox/check`: the connected inbox, read only, matched to our emails) and stored in its own tables
   (migration `007_inbox_replies.sql`, run by hand, **required**), with the labels people give replies on Positive
   Leads. It needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (same values as the dashboard's) to read the Gmail
   access the dashboard saved.
   On Positive Leads (`GET /leads/positive`) each lead is judged on its latest reply. A person's label wins; otherwise
   the unsubscribe-wording rule and then a **keyword score** (`score_reply()` in
   `app/reply_rules.py`): it starts at 0.5, each phrase found adds its weight, and **0.70 or more → Positive,
   0.40–0.70 → Needs review, below 0.40 → Not interested**; a reply with both a yes and a no goes to review, and a
   question goes to Questions unless it scores 0.70 or more. Edit the phrase list there to tune it; every reply is
   re-scored on the next page load (nothing is stored).
2. The dashboard logs the user in with Supabase Auth and calls this API through `apiFetch()` in
   `dashboard/core/api.js`, sending `Authorization: Bearer <access_token>`.
3. Every route in `app/data.py` runs `current_user` first (`app/auth.py`), which verifies the token's
   signature and expiry. A missing or invalid token gets a `401`.
4. The route runs a SQL query over `DATABASE_URL` (asyncpg pool, created on first request).
   Queries join the tables into the dashboard's view of the data:
   - a **lead** is a `contacts` row joined to its `companies` row;
   - its **status** is `Responded` if it has a reply read from Gmail that surely answers our email (reply headers or
     the same conversation; not out-of-office or bounce), then `Bounced`, `Sent` or `Not Sent`;
   - its **source** (`linkedin` / `x` / `other`) is derived from `companies.source`;
   - **sent emails** are `emails` with status `sent` or `bounced`; `sent` shows as Delivered, `bounced` as Failed;
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
python -m pytest   # the real-SQL tests (test_mail_sql, test_inbox_sql) need Postgres: sudo apt install postgresql
ruff check .        # lint (the same check CI runs on every push)
```

Tokens are verified against the project's JWKS (`/auth/v1/.well-known/jwks.json`); set `SUPABASE_JWT_SECRET`
only for legacy HS256 projects. The dashboard sends `Authorization: Bearer <session.access_token>`.
