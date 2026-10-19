-- Undoes 007_inbox_replies.sql: deletes the replies the dashboard read from Gmail and the labels people gave.
-- The agent's own tables are untouched. Run in the Supabase SQL editor only if you mean to remove the feature.
drop table if exists public.reply_labels;
drop table if exists public.inbox_seen;
drop table if exists public.inbox_replies;
