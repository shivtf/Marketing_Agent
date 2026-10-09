# Blog plan

The blog plan is the list of blogs we want to publish and when. Each week we write it as a JSON file and upload it on
the dashboard's **Blogs** page. The dashboard checks the file, saves it in Supabase and shows which blog goes out on
which day.

Each entry is a **brief**: what the blog is about and how to write it. It is not the blog text. The blog is written
from the brief later (see [What is not automatic yet](#what-is-not-automatic-yet)).

## The JSON file

```json
{
  "blogs": [
    {
      "id": "BLG-001",
      "topic": "AIDL vs HIDL: Writing a modern HAL in AOSP",
      "category": "HAL",
      "keywords": ["AIDL", "HIDL", "Treble"],
      "publish_date": "2026-10-12",
      "tone": "technical, beginner-friendly",
      "length": "1000-1500 words",
      "target_versions": ["Android 15"],
      "reference_urls": ["https://source.android.com/docs/core/architecture/aidl"]
    }
  ]
}
```

| Field             | Required | Rules                                                                                       |
|-------------------|----------|---------------------------------------------------------------------------------------------|
| `id`              | yes      | Unique in the file. Up to 40 letters, digits, `-` or `_`. Uploading the same id again updates that blog. |
| `topic`           | yes      | 10 to 200 characters.                                                                        |
| `category`        | yes      | Usually one of AOSP, HAL, BSP, Embedded, Kernel, Drivers, Security, Tooling (others give a warning). |
| `keywords`        | yes      | 1 to 10 words or phrases.                                                                    |
| `publish_date`    | yes      | `YYYY-MM-DD`, today or later.                                                                |
| `tone`            | no       | Text, up to 100 characters.                                                                  |
| `length`          | no       | Text, up to 100 characters, e.g. `"1000-1500 words"`.                                       |
| `target_versions` | no       | List of texts, e.g. `["Android 15", "Android 16"]`.                                         |
| `reference_urls`  | no       | Up to 10 links, each starting with `http://` or `https://`.                                  |

A file can have up to 60 blogs and be up to 1 MB.

## Uploading (admins only)

1. Open **Blogs** and click **Upload blog plan** at the top of the Blog Plan card.
2. Choose the `.json` file. The dashboard checks it first and saves nothing yet.
3. A preview lists every blog with its date and what will happen to it:
   - **New**: not in the plan yet.
   - **Update**: a blog with this id is already in the plan; its details will be replaced.
   - **Skipped (posted)**: that blog is already posted, so it is never changed.
4. Problems are listed in red with the blog's id and the field, for example `BLG-102 · publish_date: Use a real
   date written as YYYY-MM-DD.` While there are problems, **Import** is disabled: fix the file and upload it again.
   Warnings (in orange, e.g. two blogs on the same day) don't stop the import.
5. Click **Import**. The page shows `Imported: 4 new, 1 updated.` and the schedule refreshes.

Everyone can see the plan; only admins can upload or cancel. The backend checks the admin role in the database on
every upload, so the button being visible is not what allows it.

## What the Blogs page shows

- **Planned blogs**: how many blogs are in the plan (cancelled ones not counted).
- **This week**: how many are planned for the current week (Monday to Sunday).
- **Posted**: how many are posted.
- **Next blog**: the next date and topic.
- **The schedule**, grouped by week ("Week of Oct 12"), one row per blog with its date, topic, category and status:

| Status    | Meaning                                                        |
|-----------|----------------------------------------------------------------|
| Planned   | In the plan, not written yet.                                  |
| Written   | A blog post has been written from it, not posted yet.          |
| Posted    | Its blog is published.                                         |
| Missed    | The date has passed and it isn't posted.                       |
| Cancelled | Taken off the schedule (uploading it again brings it back).    |

Click a row to see the full brief: keywords, tone, length, target versions and reference links. Admins can
**Cancel** a blog that isn't posted yet.

## How it is stored in Supabase

Each blog in the JSON becomes **one row** in the Supabase table **`public.blog_plan`**.

### From the file to the database

```text
Your JSON file
   |  Blogs page -> Upload blog plan -> Import
   v
Dashboard (browser)
   |  sends the file
   v
Backend on Render, POST /blogs/plan/import
   1. checks you are an admin (your role in auth.users)
   2. checks every entry (ids, dates, links, ...)
   3. saves all rows in one transaction
   v
Supabase Postgres -> table public.blog_plan
```

The browser never writes to Supabase directly; only the backend does, through its database connection. Row level
security is on with no policies, so the website's public Supabase key can't read or change the table.

### What one row looks like

The `BLG-001` entry from the sample file is saved as:

| Column            | Value                                                                  |
|-------------------|------------------------------------------------------------------------|
| `id`              | `3f9c...` (generated by the database; used in the dashboard's links)   |
| `external_id`     | `BLG-001` (the JSON `id`; unique)                                      |
| `topic`           | AIDL vs HIDL: Writing a modern HAL in AOSP                             |
| `category`        | HAL                                                                    |
| `keywords`        | `{AIDL,HIDL,Treble}` (a list)                                          |
| `publish_date`    | 2026-10-12                                                             |
| `tone`            | technical, beginner-friendly                                           |
| `length`          | 1000-1500 words                                                        |
| `target_versions` | `{Android 15}`                                                         |
| `reference_urls`  | `{https://source.android.com/docs/core/architecture/aidl}`             |
| `status`          | `planned` (or `written`, `posted`, `cancelled`; Missed is worked out from the date, never stored) |
| `post_id`         | empty until a blog post is written from it (`content_posts.id`)        |
| `uploaded_by`     | email of the admin who last uploaded it                                |
| `created_at`, `updated_at` | when it was first added and last changed                      |

### What changes a row

- **Uploading the same `id` again** updates that row; it is never duplicated.
- **A posted blog's row** is never changed by an upload.
- **Cancel** sets `status` to `cancelled`. Rows are never deleted.

### The table is created automatically

Nothing has to be set up. The backend runs `create table if not exists` the first time anyone opens the Blogs page
or uploads a plan. `migrations/002_blog_plan.sql` creates the same table if you prefer to run it yourself in the SQL
editor; doing both is harmless. The table appears once the new backend is deployed on Render and the Blogs page has
been opened.

### Looking at it in Supabase

- **Table Editor** -> choose **`blog_plan`** in the list of tables.
- Or in the **SQL Editor**:

```sql
select external_id, publish_date, topic, category, status
from blog_plan
order by publish_date;
```

## Database reference

### Migrations

"This repo" is `~/Marketing_Agent/dashboardbackend`; "agent repo" is `~/Marketing-AI-Agent`.

| File | Creates | Needed for | Run by hand? |
|------|---------|------------|--------------|
| `002_blog_plan.sql` (this repo, `migrations/`) | table `blog_plan`, its index, row level security | the blog plan | Optional: the backend runs the same SQL on first use |
| `001_dashboard_presence.sql` (this repo, `migrations/`) | table `dashboard_presence` | one sign-in per account, checked on every request (uploads too) | Optional: the backend runs it on first use |
| `0002_core.sql` and later (agent repo, `supabase/migrations/`) | the agent's tables, including `content_posts` | blog posts the plan links to | Already applied; the blog plan doesn't change it |
| Built into Supabase Auth | `auth.users`, `auth.sessions` | sign-in, roles | Nothing to run |

`002_blog_plan.sql` needs `content_posts` to exist first, because `blog_plan.post_id` points to it. It already exists
in this project (the agent created it).

### Tables the blog plan uses

| Table | Owned by | Blog plan | Why |
|-------|----------|-----------|-----|
| `public.blog_plan` | this repo (`002_blog_plan.sql`) | reads and writes | the plan itself, one row per blog |
| `public.content_posts` | agent repo (`0002_core.sql`) | reads only | to show Written / Posted and the link to the posted blog (through `post_id`) |
| `auth.users` | Supabase Auth | reads only | your role (only admins upload or cancel) and whether your account was removed |
| `auth.sessions` | Supabase Auth | reads only | whether your sign-in session still exists |
| `public.dashboard_presence` | this repo (`001_dashboard_presence.sql`) | reads and writes | one sign-in per account (every request) |

### What each action does in the database

| On the Blogs page | Backend route | Database |
|-------------------|---------------|----------|
| Open the page | `GET /blogs/plan` | reads `blog_plan` joined with `content_posts` |
| Choose a file (the check) | `POST /blogs/plan/import` with `?dry_run=true` | reads which ids already exist; writes nothing |
| Import | `POST /blogs/plan/import` | one transaction: locks the existing rows, then `insert ... on conflict (external_id) do update` for each blog (posted ones skipped) |
| Click a row | `GET /blogs/plan/{id}` | reads one row |
| Cancel | `POST /blogs/plan/{id}/cancel` | `update blog_plan set status = 'cancelled'` |

Every route also checks your sign-in first (`auth.users`, `auth.sessions`, `dashboard_presence`). Values from the
file are always sent as query parameters, never pasted into the SQL.

### Rules the database enforces

- `external_id` is **unique**: the same JSON `id` can only exist once.
- `status` must be one of `planned`, `written`, `posted`, `cancelled`.
- `post_id` must point to a real `content_posts` row; if that post is deleted, `post_id` becomes empty.
- `publish_date` is **indexed**, so sorting the schedule stays fast.
- **Row level security** is on with no policies: only the backend's database connection can use the table.

### How the tables connect

```text
auth.users      1 --- *  auth.sessions        one person, several sign-ins
auth.users      1 --- 1  dashboard_presence   the one session allowed in
blog_plan       * --- 1  content_posts        post_id: the blog written from a brief
content_posts   * --- 1  topics               topic_id: the agent's own topic
```

### Table schemas

#### `public.blog_plan` (this repo, `migrations/002_blog_plan.sql`)

The blog plan. The whole migration:

```sql
-- Blog plan (app/blog_plan.py, BLOG_PLAN.md): one row per blog brief uploaded as JSON on the Blogs page.
-- The backend also creates this on first use; running it here by hand is optional. Run once in the Supabase SQL editor.
create table if not exists public.blog_plan (
  id              uuid primary key default gen_random_uuid(),
  external_id     text not null unique,           -- the JSON "id", e.g. BLG-001
  topic           text not null,
  category        text not null,
  keywords        text[] not null default '{}',
  publish_date    date not null,
  tone            text,
  length          text,
  target_versions text[] not null default '{}',
  reference_urls  text[] not null default '{}',
  status          text not null default 'planned'
                  check (status in ('planned', 'written', 'posted', 'cancelled')),
  post_id         uuid references public.content_posts (id) on delete set null,  -- the blog written from it
  uploaded_by     text,                           -- email of the admin who uploaded it
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists blog_plan_publish_date_idx on public.blog_plan (publish_date);

-- Only the dashboard backend (database connection) uses this table. RLS with no policies keeps it out of reach of
-- the browser's anon / authenticated keys.
alter table public.blog_plan enable row level security;
```

#### `public.dashboard_presence` (this repo, `migrations/001_dashboard_presence.sql`)

Which sign-in session is using each account (one sign-in per account). The whole migration:

```sql
-- One sign-in per account (app/auth.py): which session is using each account, and when it was last seen.
-- Run once in the Supabase SQL editor.
create table if not exists public.dashboard_presence (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  session_id uuid not null,
  last_seen  timestamptz not null default now()
);

-- Only the dashboard backend (database connection) uses this table. RLS with no policies keeps it out of reach of
-- the browser's anon / authenticated keys.
alter table public.dashboard_presence enable row level security;
```

#### `public.content_posts` (agent repo, `0002_core.sql` + `0003_daily_agent.sql`)

The blogs the agent writes. The blog plan only reads `id`, `status` (to show Written / Posted) and the three URL
columns (the link to the posted blog). As it is after the agent's migrations:

```sql
create table content_posts (
  id              uuid primary key default gen_random_uuid(),
  topic_id        uuid references topics (id),
  title           text,
  body_md         text,
  status          text not null default 'idea'
                  check (status in ('idea', 'drafted', 'in_review', 'approved', 'published',
                                    'rejected', 'publish_failed')),
  reviewer_note   text,
  cms_url         text,
  devto_url       text,
  linkedin_url    text,
  idempotency_key text unique,          -- 'blog-YYYY-MM-DD' for the agent's daily blog
  metrics         jsonb,
  embedding       vector(1024),
  embedding_model text,
  metadata        jsonb,                -- added in 0003_daily_agent.sql
  tags            text[],               -- added in 0003_daily_agent.sql
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),   -- set by trigger touch_updated_at
  published_at    timestamptz
);
create index content_posts_status_idx on content_posts (status);
-- Row level security on; signed-in team members may read (policy content_posts_team_read).
```

The blog plan maps the post's `status` to its own: `published` = Posted; any other status with a linked post =
Written.

#### `auth.users` and `auth.sessions` (Supabase Auth)

Supabase creates and manages these; no migration of ours changes them. The columns the backend reads:

| Table | Column | Used for |
|-------|--------|----------|
| `auth.users` | `id` | the signed-in person (the token's `sub`) |
| `auth.users` | `raw_app_meta_data` | `->>'role'` = `admin` allows upload and cancel; `->>'removed'` blocks a removed account |
| `auth.users` | `banned_until` | a banned account is refused |
| `auth.sessions` | `id`, `user_id` | whether the token's sign-in session still exists |

## Uploading again

- A blog with the same `id` is **updated** (topic, date, keywords and the rest are replaced).
- A blog whose post is already **published** is never changed and shows as Skipped.
- A **cancelled** blog uploaded again goes back to Planned.
- Blogs that are in the database but not in the new file are left as they are. To remove one, cancel it.

## What is not automatic yet

Nothing writes a blog from a brief or publishes it on its date yet. `post_id` and `status` are there so that can be
added. Options:

1. **The agent writes it.** The agent's daily blog (`~/Marketing-AI-Agent/agent/blog.py`) currently picks its own
   topic. It could instead take the next brief due within a few days from `blog_plan`, write the post, save it in
   `content_posts`, and set `post_id` and `status = 'written'`. Then decide whether the agent should stop picking its
   own topics.
2. **A scheduled job on Render** publishes posts whose brief's date has come, then sets `status = 'posted'`.
3. **By hand**: write and post the blog, then link it (set `post_id`) so the dashboard shows it as posted.

## Testing it

Two example files are in `samples/`:

- `samples/blog_plan.sample.json`: 6 valid blogs, two a week (Monday and Thursday) from Oct 12 to Oct 29, 2026.
  Upload it: the preview shows 6 New; after Import the card shows 6 planned blogs. Upload it again: 6 Update.
- `samples/blog_plan.invalid.json`: one mistake per blog (missing topic, impossible date, past date, `ftp://` link,
  duplicate id, empty keywords, unusual category). Upload it to see every problem listed and Import disabled.

The sample dates are fixed. After Oct 29, 2026 they are in the past and the valid file will be refused; change the
dates to test again.

Automated tests: `pytest tests/test_blog_plan.py` (validation with both sample files, import, dry run, admin-only,
cancel, statuses and the summary counts).
