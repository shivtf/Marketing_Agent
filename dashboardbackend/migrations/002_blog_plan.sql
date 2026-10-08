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
