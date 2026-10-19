-- Indexes for the replies read from Gmail (007_inbox_replies.sql). Run once in the Supabase SQL editor, after 007.
-- Safe to run again. Indexes only: no data changes.

-- History's "Emails Sent" looks up, for every email, the reply that answers it (app/data.py _SENT). Without this
-- index each lookup scans every saved reply: 6.2 s for a page at 20,000 emails, 0.13 s with it (audit 2026-10-19).
create index if not exists inbox_replies_email_idx on public.inbox_replies (email_id);

-- The inbox check's "look again" pass (app/inbox.py _recheck): mail judged not a reply, newest first.
create index if not exists inbox_seen_outcome_idx on public.inbox_seen (outcome, seen_at desc);
