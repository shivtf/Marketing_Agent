-- Speeds up the lead pages (app/data.py): every request checks, per lead, whether it replied and which reply is its
-- latest (replies by contact), which reply answers a sent email (replies by email), and whether we answered a reply
-- (emails by reply). Without these, each check scans the whole table. Indexes only, on the mail agent's tables: no
-- data changes, and the agent works exactly as before. Rollback: 008_lead_query_indexes_rollback.sql.
-- Run once in the Supabase SQL editor. Safe to run again. Each index takes a moment to build on a large table.
create index if not exists dashboard_replies_contact_idx on public.replies (contact_id, received_at desc);
create index if not exists dashboard_replies_email_idx on public.replies (email_id);
create index if not exists dashboard_emails_reply_idx on public.emails (reply_id) where reply_id is not null;
