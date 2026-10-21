-- Blog posting (Blogs page): this backend posts approved blogs to Dev.to (app/blog_posts.py) and records each one here.
-- Run once in the Supabase SQL editor, after 009 and 010, before deploying the backend that uses it. Safe to run again.
--
-- One row per blog of a weekly file (file_name, blog_id), claimed as 'posting' BEFORE Dev.to is called: a second
-- click, a retry or another server finds the row and doesn't post the blog again. Then 'posted' (with its url) or
-- 'failed' (with the error). Only an admin's "Post again" moves a failed row back to 'posting'.
-- `draft`: posted as a Dev.to draft (BLOG_POSTING=draft, for testing); such a blog is posted again once posting is live.
create table if not exists public.blog_posts (
  id            uuid primary key default gen_random_uuid(), -- the Blog Tracker's id for it (GET /blogs/{id})
  file_name     text not null,                  -- the weekly file, e.g. 26_10_26-31_10_26.json
  blog_id       text not null,                  -- the blog's "id" in that file, e.g. BLG-001
  site          text not null default 'devto' check (site in ('devto')),
  status        text not null check (status in ('posting', 'posted', 'failed')),
  draft         boolean not null default false,
  title         text not null,
  body_md       text not null default '',       -- what was sent to the site
  blog_hash     text not null,                  -- the approved version that was posted (blog_approval.blog_hash)
  url           text,                           -- the post on the site
  site_post_id  text,
  error         text,                           -- why it failed
  attempts      int not null default 1,
  started_by    text not null,                  -- email of the admin who clicked
  started_at    timestamptz not null default now(),
  posted_at     timestamptz,
  unique (file_name, blog_id)
);

-- RLS with no policies for anon / authenticated: the browser can't reach it. The dashboard's Next server reads it with
-- the service key (schedule badges); this backend writes it as dashboard_backend.
alter table public.blog_posts enable row level security;

grant select, insert, update on public.blog_posts to dashboard_backend;
drop policy if exists dashboard_backend_all on public.blog_posts;
create policy dashboard_backend_all on public.blog_posts for all to dashboard_backend using (true) with check (true);

-- The approvals (010): read only. Only the dashboard's Next server decides.
grant select on public.blog_approval to dashboard_backend;
drop policy if exists dashboard_backend_read on public.blog_approval;
create policy dashboard_backend_read on public.blog_approval for select to dashboard_backend using (true);
