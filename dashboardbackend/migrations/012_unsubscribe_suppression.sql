-- Unsubscribe replies reach the mail agent (audit 2026-10-21). When a person labels a reply Unsubscribe on Positive
-- Leads, its addresses go on the Marketing Agent's do-not-email list (suppression_list, agent migration 0002): the agent
-- checks it before every send and leaves suppressed contacts out of its follow-ups. Taking the label back lifts what the
-- dashboard added, and nothing else.
-- Run once in the Supabase SQL editor (as the owner), after 007 and 009, before deploying the backend that uses it.
-- Safe to run again.
--
-- The backend gets no rights on suppression_list itself: only the three functions below, which run with the owner's
-- rights and act on the addresses of one reply a person has labelled, never on an address passed in.

-- What the dashboard added to suppression_list, so taking a label back lifts only that (never the agent's own entries,
-- e.g. bounces or an unsubscribe link click). Hashed like suppression_list: the address itself is not kept here.
create table if not exists public.dashboard_suppressions (
  email_hash  text primary key,          -- suppression_list.email_hash (sha256 of the lowercased address)
  reply_id    uuid not null,             -- the labelled reply (inbox_replies) that added it
  added_by    text not null,             -- who labelled it
  created_at  timestamptz not null default now()
);
-- RLS with no policies: only the functions below (the owner) touch it.
alter table public.dashboard_suppressions enable row level security;

-- The addresses of a reply: who wrote it, and the lead it belongs to (the address the agent sends to).
create or replace function public.dashboard_reply_addresses(p_reply uuid)
returns setof text
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select distinct lower(btrim(a)) from (
    select s.from_email as a from inbox_replies s where s.id = p_reply
    union all
    select c.email from inbox_replies s join contacts c on c.id = s.contact_id where s.id = p_reply
  ) 
  where nullif(btrim(a), '') is not null
$$;

-- Put a reply's addresses on the do-not-email list. Only for a reply labelled unsubscribe. Returns how many were added
-- (0: already there).
create or replace function public.dashboard_suppress(p_reply uuid, p_by text)
returns int
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  addr text;
  n int := 0;
begin
  if not exists (select 1 from reply_labels where source = 'inbox' and reply_id = p_reply and label = 'unsubscribe') then
    return 0;
  end if;
  for addr in select dashboard_reply_addresses(p_reply) loop
    insert into suppression_list (email_hash, reason) values (email_hash(addr), 'unsubscribe')
      on conflict (email_hash) do nothing;
    if found then
      insert into dashboard_suppressions (email_hash, reply_id, added_by) values (email_hash(addr), p_reply, p_by)
        on conflict (email_hash) do nothing;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- Lift what the dashboard added for a reply whose unsubscribe label was taken back, unless another reply still labelled
-- unsubscribe has the same address. Returns how many were lifted.
create or replace function public.dashboard_unsuppress(p_reply uuid)
returns int
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  h text;
  n int := 0;
begin
  for h in select email_hash(a) from dashboard_reply_addresses(p_reply) a loop
    continue when not exists (select 1 from dashboard_suppressions where email_hash = h);
    continue when exists (
      select 1 from reply_labels hl
      where hl.source = 'inbox' and hl.label = 'unsubscribe' and hl.reply_id <> p_reply
        and exists (select 1 from dashboard_reply_addresses(hl.reply_id) b where email_hash(b) = h));
    delete from suppression_list where email_hash = h;
    delete from dashboard_suppressions where email_hash = h;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Is this address on the do-not-email list? (Shown in the reply's drawer.)
create or replace function public.dashboard_is_suppressed(p_addr text)
returns boolean
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select exists (select 1 from suppression_list where email_hash = email_hash(p_addr))
$$;

do $$
declare f text;
begin
  foreach f in array array['dashboard_reply_addresses(uuid)', 'dashboard_suppress(uuid, text)',
                           'dashboard_unsuppress(uuid)', 'dashboard_is_suppressed(text)'] loop
    execute format('revoke all on function public.%s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function public.%s from anon, authenticated', f);
    end if;
    if exists (select 1 from pg_roles where rolname = 'dashboard_backend') then
      execute format('grant execute on function public.%s to dashboard_backend', f);
    end if;
  end loop;
end $$;
