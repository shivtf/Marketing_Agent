-- Campaign names up to 400 characters (003_campaign.sql allowed 200). Same limit as the dashboard
-- (core/server/campaigns.js MAX_NAME). Run once in the Supabase SQL editor (after 003). Safe to run again.
do $$
declare c text;
begin
  -- The old limit is an unnamed check on campaign_name, so find it by what it checks rather than by name.
  for c in
    select conname from pg_constraint
    where conrelid = 'public.campaign'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%campaign_name%'
  loop
    execute format('alter table public.campaign drop constraint %I', c);
  end loop;
end $$;

alter table public.campaign add constraint campaign_name_length
  check (length(trim(campaign_name)) between 1 and 400);
