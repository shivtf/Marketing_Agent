-- Campaigns (dashboard Campaign page: dashboard/app/api/campaigns, components/CampaignsView.js).
-- Run once in the Supabase SQL editor. Safe to run again.
create table if not exists public.campaign (
  id              uuid primary key default gen_random_uuid(),
  campaign_name   text not null check (length(trim(campaign_name)) between 1 and 200),
  campaign_detail text,
  start_date      date not null,
  end_date        date not null,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint campaign_dates_in_order check (end_date >= start_date)
);
create index if not exists campaign_start_date_idx on public.campaign (start_date);

-- Only the dashboard's server (service role key) reads and writes this table. RLS with no policies keeps it out of
-- reach of the browser's anon / authenticated keys.
alter table public.campaign enable row level security;