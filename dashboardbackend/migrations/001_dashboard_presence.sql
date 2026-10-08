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
