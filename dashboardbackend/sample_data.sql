-- Sample rows so the dashboard has something to show. Run in the Supabase SQL editor.
-- Safe to run twice. All rows use *.example domains and 'sample-' keys, so the cleanup at the bottom
-- removes exactly these rows and nothing else. Requires supabase/migrations/0002_core.sql, 0005_email_tracking.sql (emails.reply_id)
-- and 0006_reply_review.sql (replies.review_note).

insert into companies (id, name, domain, status, source, source_url) values
  ('00000000-0000-4000-8000-0000000000a1', 'CloudScale',      'cloudscale.example',  'engaged',       'linkedin', 'https://www.linkedin.com/company/cloudscale'),
  ('00000000-0000-4000-8000-0000000000a2', 'TechFlow Studio', 'techflow.example',    'engaged',       'x',        'https://x.com/techflowstudio'),
  ('00000000-0000-4000-8000-0000000000a3', 'North Star Media','northstar.example',   'engaged',       'linkedin', 'https://www.linkedin.com/company/northstar'),
  ('00000000-0000-4000-8000-0000000000a4', 'BuildIt Labs',    'builditlabs.example', 'contact_found', 'github',   'https://github.com/builditlabs'),
  ('00000000-0000-4000-8000-0000000000a5', 'DevHub',          'devhub.example',      'engaged',       'linkedin', 'https://www.linkedin.com/company/devhub'),
  ('00000000-0000-4000-8000-0000000000a6', 'Spark Digital',   'sparkdigital.example','verified',      'x',        'https://x.com/sparkdigital')
on conflict (id) do nothing;

insert into contacts (id, company_id, name, role, email, verification, source_url, collected_at) values
  ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', 'Priya Sharma', 'Head of Content',           'priya@cloudscale.example',   'verified', 'https://www.linkedin.com/in/priya-sharma', now() - interval '6 days'),
  ('00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000a2', 'Daniel Kim',   'Product Marketing Manager', 'daniel@techflow.example',    'verified', 'https://x.com/danielkim',                  now() - interval '5 days'),
  ('00000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-0000000000a3', 'Aisha Khan',   'Growth Marketing Lead',     'aisha@northstar.example',    'verified', 'https://www.linkedin.com/in/aisha-khan',   now() - interval '4 days'),
  ('00000000-0000-4000-8000-0000000000b4', '00000000-0000-4000-8000-0000000000a4', 'Marcus Lee',   'Founder & CEO',             'marcus@builditlabs.example', 'verified', 'https://github.com/marcuslee',             now() - interval '3 days'),
  ('00000000-0000-4000-8000-0000000000b5', '00000000-0000-4000-8000-0000000000a5', 'Sophia Chen',  'Marketing Director',        'sophia@devhub.example',      'verified', 'https://www.linkedin.com/in/sophia-chen',  now() - interval '2 days'),
  ('00000000-0000-4000-8000-0000000000b6', '00000000-0000-4000-8000-0000000000a6', 'Li Wei',       'Digital Marketing Manager', 'li@sparkdigital.example',    'verified', 'https://x.com/liwei',                      now() - interval '1 day')
on conflict (id) do nothing;

insert into campaigns (id, name) values
  ('00000000-0000-4000-8000-0000000000c1', 'Sample campaign')
on conflict (id) do nothing;

-- Five sent (one bounced) plus one still a draft; the draft is hidden from the History page on purpose.
insert into emails (id, contact_id, campaign_id, status, subject, body, mailbox, idempotency_key, sent_at) values
  ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c1', 'sent',    'Collaboration opportunity',                 E'Hi Priya,\n\nI came across CloudScale and loved your recent posts. We help teams publish content that performs.\n\nWould you be open to a quick chat this week?\n\nBest,\nAlex', 'you@youragency.example', 'sample-email-1', now() - interval '5 days'),
  ('00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000c1', 'sent',    'Quick question',                            E'Hi Daniel,\n\nQuick question about how TechFlow Studio plans its content calendar.\n\nBest,\nAlex',                                                                                                  'you@youragency.example', 'sample-email-2', now() - interval '4 days'),
  ('00000000-0000-4000-8000-0000000000d3', '00000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-0000000000c1', 'sent',    'Introducing our content marketing services',E'Hi Aisha,\n\nWe help growing brands attract and convert more customers through content.\n\nBest,\nAlex',                                                                                             'you@youragency.example', 'sample-email-3', now() - interval '3 days'),
  ('00000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-0000000000b4', '00000000-0000-4000-8000-0000000000c1', 'sent',    'Resources for you',                         E'Hi Marcus,\n\nSharing a few resources that might help BuildIt Labs grow organic traffic.\n\nBest,\nAlex',                                                                                      'you@youragency.example', 'sample-email-4', now() - interval '2 days'),
  ('00000000-0000-4000-8000-0000000000d5', '00000000-0000-4000-8000-0000000000b5', '00000000-0000-4000-8000-0000000000c1', 'sent',    'Let''s connect',                            E'Hi Sophia,\n\nNice to e-meet you. Would love to connect about DevHub''s Q3 plans.\n\nBest,\nAlex',                                                                                      'you@youragency.example', 'sample-email-5', now() - interval '30 hours'),
  ('00000000-0000-4000-8000-0000000000d6', '00000000-0000-4000-8000-0000000000b6', '00000000-0000-4000-8000-0000000000c1', 'bounced', 'Partnership idea',                          E'Hi Li,\n\nI have a partnership idea for Spark Digital.\n\nBest,\nAlex',                                                                                                               'you@youragency.example', 'sample-email-6', now() - interval '20 hours')
on conflict (id) do nothing;

-- Replies: two interested (these appear on Positive Leads), one question, one not interested.
-- More replies below cover the other Positive Leads rules.
insert into replies (id, email_id, contact_id, message_id, status, label, body, received_at) values
  ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000b1', '<sample-reply-1@example>', 'classified', 'interested',     E'Hi Alex,\n\nThanks for reaching out, this looks interesting. Could you share a couple of examples of posts you have published for similar teams? A call on Thursday afternoon would work for me.\n\nThanks,\nPriya', now() - interval '4 days'),
  ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000000b2', '<sample-reply-2@example>', 'classified', 'question',       E'Hi Alex,\n\nWe already work with an agency, but I would be curious how your reporting works. Can you send a short deck?\n\nThanks,\nDaniel',                                                              now() - interval '3 days'),
  ('00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-0000000000d3', '00000000-0000-4000-8000-0000000000b3', '<sample-reply-3@example>', 'classified', 'interested',     E'Hi Alex,\n\nPlease send pricing for a content package and we will review it internally.\n\nThanks,\nAisha',                                                                                          now() - interval '2 days'),
  ('00000000-0000-4000-8000-0000000000e4', '00000000-0000-4000-8000-0000000000d5', '00000000-0000-4000-8000-0000000000b5', '<sample-reply-4@example>', 'classified', 'not_interested', E'Hi Alex,\n\nNot a fit for us right now, but please check back in the new year.\n\nThanks,\nSophia',                                                                                         now() - interval '1 day')
on conflict (id) do nothing;

-- Replies that exercise the Positive Leads rules (each lead is judged on its latest reply from a person):
--   e5 Marcus: only an out-of-office reply       -> ignored; he stays "Awaiting" and isn't counted as replied
--   e6 Sophia: said yes before her later "no"   -> the later "no" (e4) wins, so she is not positive
--   e7 Li:     interested, but low confidence     -> "Needs review"
--   e8 Daniel: new reply not classified yet       -> "1 new reply is being classified"; his question (e2) still shows
-- Expected on Positive Leads: Positive 2 (Aisha waiting, Priya answered), Needs review 1, Questions 1,
-- Leads Replied 5, Positive Rate 40%.
insert into replies (id, email_id, contact_id, message_id, status, label, review_note, body, received_at) values
  ('00000000-0000-4000-8000-0000000000e5', '00000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-0000000000b4', '<sample-reply-5@example>', 'handled',    'ooo',        null,                    E'I am out of the office until Monday with limited access to email.\n\nMarcus',                                                       now() - interval '47 hours'),
  ('00000000-0000-4000-8000-0000000000e6', '00000000-0000-4000-8000-0000000000d5', '00000000-0000-4000-8000-0000000000b5', '<sample-reply-6@example>', 'classified', 'interested', null,                    E'Hi Alex,\n\nThis sounds interesting, let me check with the team.\n\nSophia',                                                        now() - interval '29 hours'),
  ('00000000-0000-4000-8000-0000000000e7', null,                                   '00000000-0000-4000-8000-0000000000b6', '<sample-reply-7@example>', 'classified', 'interested', 'confidence 0.45 < 0.6', E'Hi Alex,\n\nMaybe later in the year. Could be interesting once our budget is set.\n\nLi',                                           now() - interval '10 hours'),
  ('00000000-0000-4000-8000-0000000000e8', '00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000000b2', '<sample-reply-8@example>', 'received',   null,         null,                    E'Hi Alex,\n\nFollowing up on my question about reporting.\n\nDaniel',                                                                 now() - interval '1 hour')
on conflict (id) do nothing;

-- Our answer to Priya's reply (e1), so she shows "We replied". Step 2: step 1 is the first outreach email.
insert into emails (id, contact_id, campaign_id, step, status, subject, body, mailbox, idempotency_key, sent_at, reply_id) values
  ('00000000-0000-4000-8000-0000000000d7', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c1', 2, 'sent', 'Re: Collaboration opportunity', E'Hi Priya,\n\nGreat to hear. Does Thursday at 3pm or Friday at 11am work for a short call?\n\nBest,\nAlex', 'you@youragency.example', 'sample-email-7', now() - interval '3 days', '00000000-0000-4000-8000-0000000000e1')
on conflict (id) do nothing;

insert into content_posts (id, title, body_md, status, devto_url, published_at) values
  ('00000000-0000-4000-8000-0000000000f1', '10 Productivity Tips for Remote Developers', E'## Introduction\n\nWorking remotely gives developers freedom, but it removes the structure of an office.\n\n## Tips\n\n1. Protect your deep-work hours.\n2. Plan tomorrow before you log off.\n3. Default to asynchronous communication.', 'published', 'https://dev.to/sample/productivity-tips', now() - interval '20 days'),
  ('00000000-0000-4000-8000-0000000000f2', 'Building a SaaS Product in 2026',               E'## Why now\n\nThe tools available to a small team have never been better.\n\n## Start narrow\n\nPick one painful, specific problem for one type of customer.',                                                'published', 'https://dev.to/sample/saas-2026',         now() - interval '9 days'),
  ('00000000-0000-4000-8000-0000000000f3', 'How to Build a Personal Brand as a Developer',  E'## Why it matters\n\nYour reputation travels further than your resume.\n\n## Start with what you know\n\nWrite about problems you solved this week.',                                                                  'drafted',   null,                                       null)
on conflict (id) do nothing;

-- ---------- Cleanup: run this block to remove the sample data ----------
-- delete from replies       where message_id like '<sample-reply-%';  -- first: replies are only unlinked, not deleted, with their contact
-- delete from companies     where domain like '%.example';          -- cascades to contacts and emails
-- delete from campaigns     where id = '00000000-0000-4000-8000-0000000000c1';
-- delete from content_posts where id::text like '00000000-0000-4000-8000-0000000000f%';
