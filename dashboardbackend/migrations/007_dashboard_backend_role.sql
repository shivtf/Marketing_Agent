-- A limited database login for this backend (audit 2026-10-17, F-06). Until now it used the database owner, so a leaked
-- .env gave full control of every table: leads, approvals, the Campaign Agent's publishing functions.
-- Run once in the Supabase SQL editor (as the owner). Safe to run again.
--
-- The backend reads the Marketing Agent's lead tables, keeps its one-sign-in table, adds a contact through
-- submit_manual_contact(), and needs four facts about Supabase Auth. Those four go through the functions below, which
-- run with the owner's rights but can do nothing else. Then: set a password
--   alter role dashboard_backend with login password '...';
-- and use the pooler URL with that user as DATABASE_URL in dashboardbackend/.env.

do $$ begin
  create role dashboard_backend nologin;
exception when duplicate_object then null;
end $$;
alter role dashboard_backend connection limit 10;
alter role dashboard_backend set idle_in_transaction_session_timeout = '60s';
alter role dashboard_backend set lock_timeout = '30s';
grant usage on schema public to dashboard_backend;

-- Read only: what the pages show.
do $$
declare t text;
begin
  foreach t in array array['companies', 'contacts', 'emails', 'replies', 'content_posts', 'content_variants',
                           'approvals', 'campaign', 'blog_plan'] loop
    if to_regclass('public.' || t) is not null then
      execute format('grant select on public.%I to dashboard_backend', t);
      execute format('drop policy if exists dashboard_backend_read on public.%I', t);
      execute format('create policy dashboard_backend_read on public.%I for select to dashboard_backend using (true)', t);
    end if;
  end loop;
end $$;

-- Its own table.
grant select, insert, update, delete on public.dashboard_presence to dashboard_backend;
drop policy if exists dashboard_backend_all on public.dashboard_presence;
create policy dashboard_backend_all on public.dashboard_presence
for all to dashboard_backend using (true) with check (true);

-- The one write to the leads (Marketing Agent migration 0013).
do $$ begin
  if to_regprocedure('public.submit_manual_contact(uuid,text,text,text,text)') is not null then
    grant execute on function public.submit_manual_contact(uuid, text, text, text, text) to dashboard_backend;
  end if;
end $$;

-- Supabase Auth, through narrow functions with the owner's rights.

-- Is this sign-in session still alive, and is the account removed or banned?
create or replace function public.dashboard_account_state(p_user uuid, p_session uuid)
returns table (session_alive boolean, removed boolean)
language sql stable security definer set search_path = public, auth, pg_temp as $$
  select exists (select 1 from auth.sessions s where s.id = p_session and s.user_id = u.id),
         coalesce((u.raw_app_meta_data->>'removed')::boolean, false) or coalesce(u.banned_until > now(), false)
  from auth.users u where u.id = p_user
$$;

-- The account's dashboard role, from the database (a token can be an hour out of date).
create or replace function public.dashboard_user_role(p_user uuid)
returns text
language sql stable security definer set search_path = public, auth, pg_temp as $$
  select raw_app_meta_data->>'role' from auth.users where id = p_user
$$;

-- Take or keep the account for this session (the one-sign-in rule; see app/auth.py _CLAIM).
create or replace function public.dashboard_claim(p_user uuid, p_session uuid, p_hold interval)
returns uuid
language sql security definer set search_path = public, auth, pg_temp as $$
  insert into public.dashboard_presence as p (user_id, session_id, last_seen) values (p_user, p_session, now())
  on conflict (user_id) do update set session_id = excluded.session_id, last_seen = now()
    where p.session_id = excluded.session_id
       or p.last_seen < now() - p_hold
       or not exists (select 1 from auth.sessions s where s.id = p.session_id)
  returning session_id
$$;

-- End a user's sign-in sessions (all, or all but one). Returns how many.
create or replace function public.dashboard_end_sessions(p_user uuid, p_keep uuid default null)
returns int
language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare n int;
begin
  delete from auth.sessions where user_id = p_user and (p_keep is null or id <> p_keep);
  get diagnostics n = row_count;
  return n;
end $$;

do $$
declare f text;
begin
  foreach f in array array['dashboard_account_state(uuid, uuid)', 'dashboard_user_role(uuid)',
                           'dashboard_claim(uuid, uuid, interval)', 'dashboard_end_sessions(uuid, uuid)'] loop
    execute format('revoke all on function public.%s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function public.%s from anon, authenticated', f);
    end if;
    execute format('grant execute on function public.%s to dashboard_backend', f);
  end loop;
end $$;
