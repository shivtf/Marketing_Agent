-- Blog approval (Blogs page): an admin's decision on one blog of a weekly blog file (Supabase Storage, bucket
-- blog-plans). No row = waiting. Written only by the dashboard's server (service role key, dashboard/app/api/blogs).
-- Run once in the Supabase SQL editor, before deploying the dashboard that uses it. Safe to run again.
--
-- The publishing backend is now dashboardbackend itself (app/blog_posts.py, table blog_posts in 011). Its rules:
--   1. Post a blog only when it has a row here with status = 'approved'. No row (waiting) or 'rejected': never post.
--   2. Post `blog`: the copy taken when it was approved, not the blog as it is in the file now. (When a file is
--      replaced, the dashboard deletes the 'approved' rows of blogs that changed or are gone, so they wait again.)
--   3. Ask right before posting: an admin can take an approval back until then.
--        select file_name, blog_id, blog from public.blog_approval
--        where status = 'approved' and publish_date = current_date;
--   4. Read it with server credentials (service role key, or a login granted `select` on this table: 011 grants it to
--      dashboard_backend). What was posted is recorded in blog_posts (011).
create table if not exists public.blog_approval (
  file_name    text not null,                  -- the weekly file, e.g. 26_10_26-31_10_26.json
  blog_id      text not null,                  -- the blog's "id" in that file, e.g. BLG-001
  status       text not null check (status in ('approved', 'rejected')),
  blog         jsonb not null,                 -- the blog exactly as it was in the file when decided
  blog_hash    text not null,                  -- sha256 of that blog (keys sorted): a changed blog needs a new decision
  publish_date date,                           -- the blog's publish_date (null if not a real day: such a blog can't be approved)
  reason       text,                           -- why it was rejected
  decided_by   text not null,                  -- email of the admin
  decided_at   timestamptz not null default now(),
  primary key (file_name, blog_id),
  constraint blog_approval_reject_reason check (status <> 'rejected' or coalesce(btrim(reason), '') <> ''),
  constraint blog_approval_approved_date check (status <> 'approved' or publish_date is not null)
);
-- The publishing backend's question: what is approved for a given day.
create index if not exists blog_approval_approved_day_idx on public.blog_approval (publish_date) where status = 'approved';

-- RLS with no policies keeps it out of reach of the browser's anon / authenticated keys.
alter table public.blog_approval enable row level security;
