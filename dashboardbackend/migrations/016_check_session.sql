-- One round trip for the dashboard's sign-in check (app/auth.py _check_session), instead of dashboard_account_state
-- followed by dashboard_claim. Same rules as those two: a user that no longer exists, an ended session or a removed
-- account is answered without touching the presence row; otherwise the account is claimed for this session.
-- Run once in the Supabase SQL editor (after 001 and 009), BEFORE deploying the code that calls it. Safe to run again.

create or replace function public.dashboard_check_session(p_user uuid, p_session uuid, p_hold interval)
returns table (ended boolean, is_removed boolean, holds boolean)
language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  a record;
  h boolean;
begin
  select * into a from public.dashboard_account_state(p_user, p_session);
  if not found then  -- the user no longer exists
    return query select true, true, true;
    return;
  end if;
  if not a.session_alive or a.removed then
    return query select not a.session_alive, a.removed, true;
    return;
  end if;
  select public.dashboard_claim(p_user, p_session, p_hold) is not null into h;
  return query select false, false, h;
end $$;

revoke all on function public.dashboard_check_session(uuid, uuid, interval) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.dashboard_check_session(uuid, uuid, interval) from anon, authenticated;
  end if;
end $$;
grant execute on function public.dashboard_check_session(uuid, uuid, interval) to dashboard_backend;
