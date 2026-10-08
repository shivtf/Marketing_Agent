# Dashboard backend

Python (FastAPI) API for the dashboard. Sign-in, sign-out and password reset stay with Supabase Auth
(the browser talks to it directly); this service verifies the Supabase access token on every protected call.

| Route                                                      | Auth   | Purpose                                      |
|------------------------------------------------------------|--------|----------------------------------------------|
| `GET /health`                                              | none   | liveness                                     |
| `GET /auth/me`                                             | Bearer | returns `id`, `email`, `role` of the user    |
| `GET /leads`, `/leads/stats`, `/leads/positive`, `/leads/{id}` | Bearer | leads, counts, positive / review / question leads (latest human reply), one lead |
| `GET /emails/sent`, `/emails/sent/{id}`                    | Bearer | sent emails                                  |
| `GET /emails/replies`, `/emails/replies/{id}`              | Bearer | replies, with the email each one answers     |
| `GET /blogs`, `/blogs/{id}`                                | Bearer | blog posts and their publish status          |
| `GET /agent`, `POST /agent/start`, `POST /agent/stop`      | Bearer | agent status / Start / Stop, forwarded to the pipeline control API (`pipeline-api.md`) |
| `GET /blogs/plan`, `GET /blogs/plan/{id}`                  | Bearer | the blog plan (briefs by date) and one brief; see `BLOG_PLAN.md` |
| `POST /blogs/plan/import`, `POST /blogs/plan/{id}/cancel`  | Admin  | upload a blog plan JSON (`?dry_run=true` checks only), cancel a brief |

Protect a new route with `user: dict = Depends(current_user)` (`app/auth.py`).

## How the data gets to the dashboard

```text
lead / outreach / content services ──write──▶ Supabase Postgres ◀──read-only── app/data.py ──JSON──▶ dashboard
```

1. The pipeline services (`services/*`) write companies, contacts, emails, replies and content posts to
   Supabase Postgres (`supabase/migrations/0002_core.sql`). This backend never writes to those tables.
2. The dashboard logs the user in with Supabase Auth and calls this API through `apiFetch()` in
   `eval/dashboard/core/api.js`, sending `Authorization: Bearer <access_token>`.
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
   dashboard used before (`eval/dashboard/core/data.js`). List routes leave out heavy fields
   (email and blog bodies); the `/{id}` routes include them.
6. Start/Stop (`app/agent.py`) don't touch the database: they call the pipeline control API with
   `AGENT_API_TOKEN` (the API's `PIPELINE_API_TOKEN`; that name works too) and `AGENT_API_URL` (defaults to the
   Render URL). The token never reaches the browser.

To add a new data route, write a query in `app/data.py`, return it through `_rows()` / `_one()`, then add a
one-line `apiFetch()` function for it in `api.js`.

## Run

```bash
cd eval/dashboardbackend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in SUPABASE_URL and DATABASE_URL (the pooled Postgres connection string)
uvicorn app.main:app --reload --port 8000
pytest
```

Tokens are verified against the project's JWKS (`/auth/v1/.well-known/jwks.json`); set `SUPABASE_JWT_SECRET`
only for legacy HS256 projects. The dashboard sends `Authorization: Bearer <session.access_token>`.
