-- Positive Leads remembers each reply's keyword score instead of working it out again on every page load: a saved
-- reply's text never changes, nor does the email it answers. The inbox check (app/inbox.py) scores a reply when it saves
-- it; replies saved before this migration are scored on the next Positive Leads load and saved then (app/data.py).
-- Run once in the Supabase SQL editor, after 007, before deploying the backend that uses it. Safe to run again.
-- Columns only, no data changes. Rollback: alter table public.inbox_replies drop column score_data, drop column scored_with;
-- The dashboard_backend login (009) already has update rights on inbox_replies, so it needs no new grant.

alter table public.inbox_replies
  -- app/reply_rules.py score_saved(): { score, hits, question, later, referral, unsubscribe, preview }
  add column if not exists score_data  jsonb,
  -- The RULES_VERSION (app/reply_rules.py) it was scored with: a reply scored with older rules is scored again.
  add column if not exists scored_with int;
