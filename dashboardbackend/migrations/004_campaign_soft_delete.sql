-- Campaign soft delete: Delete on the Campaign page sets deleted_at instead of removing the row, and the dashboard
-- hides rows where it is set. Run once in the Supabase SQL editor (after 003_campaign.sql). Safe to run again.
alter table public.campaign add column if not exists deleted_at timestamptz;
create index if not exists campaign_not_deleted_idx on public.campaign (start_date) where deleted_at is null;
