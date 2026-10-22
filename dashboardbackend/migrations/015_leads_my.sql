-- Materialized lead list (app/data.py _LEADS reads public.lead_my). Run once in the Supabase SQL editor BEFORE deploying
-- the code that reads it. The query is the old _LEADS CTE, unchanged. The data is only as fresh as the last refresh:
-- app/data.py refresh_leads() calls dashboard_refresh_leads() after an inbox check, a label and a manual contact; the
-- agent's own writes (new leads, sent emails) show up on the next refresh, so also schedule it, e.g. with pg_cron:
--   select cron.schedule('lead_my', '* * * * *', 'select public.dashboard_refresh_leads()');

create materialized view if not exists public.lead_my as
select x.*, row_number() over (order by x.added_at, x.id) as number from (
select c.id,
       coalesce(c.name, c.email, co.name) as name, c.role as title, co.name as company,
       'https://' || co.domain as company_url, co.source_url as profile_url, c.email,
       -- What the company does: the agent's project summary for it, else its industry.
       coalesce(nullif(btrim(co.project_summary), ''), nullif(btrim(co.industry), '')) as about,
       -- Where the agent found the lead: 'leadgen:search' -> 'search', 'leadgen:feed:hn_hiring' -> 'hn_hiring'.
       coalesce(nullif(regexp_replace(lower(coalesce(co.source, '')), '^(leadgen:)?(feed:)?', ''), ''), 'other')
         as source,
       -- Where outreach stands: a reply from a person wins, then a bounce, then a delivered email; otherwise nothing
       -- has been sent yet. Any mail from the lead counts as a reply, including a new thread from their address (we
       -- emailed them first). Out-of-office and bounce messages are automatic, so they don't count.
       case when exists (select 1 from inbox_replies s
                         left join reply_labels hl on hl.source = 'inbox' and hl.reply_id = s.id
                         where s.contact_id = c.id and coalesce(hl.label, s.auto_label, '') not in ('ooo', 'bounce'))
              then 'Responded'
            when exists (select 1 from emails e where e.contact_id = c.id and e.status = 'bounced')
              or exists (select 1 from inbox_replies s where s.contact_id = c.id and s.auto_label = 'bounce')
              then 'Bounced'
            when exists (select 1 from emails e where e.contact_id = c.id
                                                and e.status = 'sent' and e.sent_at is not null)
              then 'Sent'
            else 'Not Sent' end as status,
       c.collected_at as added_at, c.last_engaged_at as last_contact_at
from contacts c join companies co on co.id = c.company_id
union all
select co.id, co.name, null, co.name, 'https://' || co.domain, co.source_url, null,
       coalesce(nullif(btrim(co.project_summary), ''), nullif(btrim(co.industry), '')),
       coalesce(nullif(regexp_replace(lower(coalesce(co.source, '')), '^(leadgen:)?(feed:)?', ''), ''), 'other'),
       'No Contact', co.created_at, null
from companies co
where co.lead_status not in ('DISCOVERED', 'REJECTED')
  and not exists (select 1 from contacts c where c.company_id = co.id)
) x
with data;

-- The unique index is required for refresh ... concurrently (readers are not blocked while it rebuilds).
create unique index if not exists lead_my_id_idx            on public.lead_my (id);
create index if not exists lead_my_number_idx               on public.lead_my (number desc);
create index if not exists lead_my_status_number_idx        on public.lead_my (status, number desc);
create index if not exists lead_my_source_number_idx        on public.lead_my (source, number desc);

-- The backend role can only call functions (migration 009), so refreshing goes through one.
create or replace function public.dashboard_refresh_leads() returns void
language sql security definer set search_path = public as
$$ refresh materialized view concurrently public.lead_my $$;
revoke all on function public.dashboard_refresh_leads() from public;
grant execute on function public.dashboard_refresh_leads() to dashboard_backend;
