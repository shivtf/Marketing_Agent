-- Positive Leads: replies the dashboard reads from Gmail itself (app/inbox.py), and labels people give replies.
-- The mail agent only sends; every reply is read by the dashboard backend. Read only: the dashboard never sends,
-- changes or deletes mail, and never writes to the agent's tables (emails, contacts, ...). Rollback: 007_inbox_replies_rollback.sql.
-- Run once in the Supabase SQL editor. Safe to run again.

-- A genuine reply to our outreach, found in the connected Gmail inbox and matched to the email we sent.
create table if not exists public.inbox_replies (
  id               uuid primary key default gen_random_uuid(),
  gmail_message_id text not null unique,          -- Gmail's id: each message is stored once
  gmail_thread_id  text,
  message_id       text,                          -- the RFC Message-ID header (the agent's replies use it too)
  email_id         uuid,                          -- the email of ours it answers (emails.id)
  contact_id       uuid,                          -- that email's lead (contacts.id)
  -- How it was matched: header = In-Reply-To / References name our email, thread = same Gmail conversation as our
  -- email, sender = only the address matches a lead (e.g. a new thread; still counted as the lead's reply, but not
  -- linked to one particular email on History).
  match_method     text not null check (match_method in ('header', 'thread', 'sender')),
  from_email       text not null,
  subject          text,
  body             text,                          -- the mail as text, at most 20,000 characters
  received_at      timestamptz not null,
  auto_label       text check (auto_label in ('ooo', 'bounce')),  -- set by rules for automatic mail; else null
  we_replied_at    timestamptz,                   -- when a later message in the thread was sent by us (Gmail SENT)
  thread_checked_at timestamptz,                  -- when we last looked for that answer
  created_at       timestamptz not null default now()
);
create index if not exists inbox_replies_contact_idx on public.inbox_replies (contact_id, received_at desc);
create index if not exists inbox_replies_message_idx on public.inbox_replies (message_id);

-- Every Gmail message the dashboard has looked at and what it was, so none is read twice (replies, our own mail,
-- mail that answers nothing of ours, bounces we could not match).
create table if not exists public.inbox_seen (
  gmail_message_id text primary key,
  outcome          text not null check (outcome in ('reply', 'own', 'not_reply', 'bounce', 'bounce_unmatched')),
  seen_at          timestamptz not null default now()
);

-- The label a person gave a reply on Positive Leads. It wins over the keyword score and the automatic label, and is
-- the start of a reviewed training set for a future classifier.
create table if not exists public.reply_labels (
  source     text not null check (source in ('agent', 'inbox')),  -- always 'inbox' (inbox_replies.id); 'agent' is unused
  reply_id   uuid not null,
  label      text not null
    check (label in ('interested', 'question', 'not_interested', 'unsubscribe', 'ooo', 'bounce')),
  labelled_by text,                               -- email of the person who chose it
  labelled_at timestamptz not null default now(),
  primary key (source, reply_id)
);

-- Only the dashboard backend (database connection) uses these tables. RLS with no policies keeps them out of reach of
-- the browser's anon / authenticated keys.
alter table public.inbox_replies enable row level security;
alter table public.inbox_seen enable row level security;
alter table public.reply_labels enable row level security;
