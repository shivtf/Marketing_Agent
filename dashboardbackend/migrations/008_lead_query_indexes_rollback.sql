-- Undoes 008_lead_query_indexes.sql (the lead pages work the same, only slower). No data is touched.
drop index if exists public.dashboard_replies_contact_idx;
drop index if exists public.dashboard_replies_email_idx;
drop index if exists public.dashboard_emails_reply_idx;
