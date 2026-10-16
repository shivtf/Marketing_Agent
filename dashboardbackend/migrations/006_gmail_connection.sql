-- Gmail inbox on the History page (dashboard/app/api/gmail, core/server/gmail.js): the one Gmail account an admin
-- connected, read only (scope gmail.readonly). refresh_token is encrypted by the dashboard's server (AES-256-GCM, key
-- derived from GOOGLE_CLIENT_SECRET), so a copy of this table alone can't read the inbox.
-- Run once in the Supabase SQL editor. Safe to run again.
create table if not exists public.gmail_connection (
  id            smallint primary key default 1 check (id = 1),  -- one connected inbox for the whole dashboard
  email         text not null,                                  -- the connected Gmail address
  refresh_token text not null,                                  -- encrypted: v1.<iv>.<tag>.<data>
  connected_by  text,                                           -- email of the admin who connected it
  connected_at  timestamptz not null default now()
);

-- Only the dashboard's server (service role key) reads and writes this table. RLS with no policies keeps it out of
-- reach of the browser's anon / authenticated keys.
alter table public.gmail_connection enable row level security;
