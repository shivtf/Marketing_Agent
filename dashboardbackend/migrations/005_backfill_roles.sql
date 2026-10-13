-- Dashboard roles: the dashboard and its backend refuse any account without app_metadata.role = 'admin' or 'employee'
-- (dashboardbackend/app/auth.py current_user, dashboard/core/server/supabaseAdmin.js getCaller). Users created on
-- the Users page get 'employee' from now on; this gives it to the employees created before that.
-- Run once in the Supabase SQL editor, BEFORE deploying the role check, or those employees are refused.

-- 1. Look at every account. Remove any email you don't recognise on the Users page instead of giving it a role.
select email, created_at, last_sign_in_at,
       raw_app_meta_data->>'role' as role,
       raw_app_meta_data->>'removed' as removed
from auth.users
order by created_at;

-- 2. Give the employee role to the accounts you recognise, by name (never to every account without a role).
--    Replace the emails below with the real ones, then run this statement.
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role": "employee"}'::jsonb
where raw_app_meta_data->>'role' is null
  and lower(email) in ('employee1@company.com', 'employee2@company.com');
