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
| `GET /emails/replies`, `/emails/replies/{id}`              | Bearer | replies, with the email each one answers     |
| `GET /blogs`, `/blogs/{id}`                                | Bearer | blog posts and their publish status          |

Protect a new route with `user: dict = Depends(current_user)` (`app/auth.py`).

## How the data gets to the dashboard

```text
lead / outreach / content services ──write──▶ Supabase Postgres ◀──read-only── app/data.py ──JSON──▶ dashboard
```

1. The pipeline services (`services/*`) write companies, contacts, emails, replies and content posts to
   Supabase Postgres. This backend never writes to those tables, except for the one function call below.
   A company with no contact (`NEEDS_CONTACT`) gets its email from a person here: `POST /needs-contact/{id}/contact` calls
   the SQL function `submit_manual_contact()` (Marketing-AI-Agent migration `0013`), the agent drafts the email and posts the
   approval request to Slack. Nothing is sent from here.
2. The dashboard logs the user in with Supabase Auth and calls this API through `apiFetch()` in
   `dashboard/core/api.js`, sending `Authorization: Bearer <access_token>`.
3. Every route in `app/data.py` runs `current_user` first (`app/auth.py`), which verifies the token's
   signature and expiry. A missing or invalid token gets a `401`.
4. The route runs a SQL query over `DATABASE_URL` (asyncpg pool, created on first request).
   Queries join the tables into the dashboard's view of the data:
   - a **lead** is a `contacts` row joined to its `companies` row;
   - its **status** is `Responded` if the contact has any `replies` row, otherwise `Awaiting`;
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
pip install -r requirements.txt
# create .env with SUPABASE_URL and DATABASE_URL (the pooled Postgres connection string)
uvicorn app.main:app --reload --port 8000
python -m pytest
```

Tokens are verified against the project's JWKS (`/auth/v1/.well-known/jwks.json`); set `SUPABASE_JWT_SECRET`
only for legacy HS256 projects. The dashboard sends `Authorization: Bearer <session.access_token>`.

## Database login

Use the limited `dashboard_backend` login, not the database owner: run `migrations/007_dashboard_backend_role.sql` once
in the Supabase SQL editor, set its password (`alter role dashboard_backend with login password '...'`), and put the
pooler URL with that user in `DATABASE_URL`. It can read the lead tables, keep `dashboard_presence`, call
`submit_manual_contact()`, and reach Supabase Auth only through four narrow functions in that file. Until 007 is applied
the code falls back to the owner's direct queries, so the order of deploying does not matter.

A change (any request that is not a read) is refused with 503 while the sign-in check cannot reach the database; reads
still work.
