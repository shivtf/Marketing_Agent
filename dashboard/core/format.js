// Small formatting helpers shared by every page and the drawer.
// Reply labels from the reply classifier (replies.label), as shown in the dashboard.
export const REPLY_LABELS = {
  interested: 'Interested', question: 'Question', not_interested: 'Not interested',
  ooo: 'Out of office', bounce: 'Bounced', unsubscribe: 'Unsubscribed',
};

// A lead's reply outcome (backend /leads `reply`), in the order the dashboard lists them.
export const LEAD_REPLY_LABELS = {
  interested: 'Interested', question: 'Question', not_interested: 'Not interested', unsubscribe: 'Unsubscribed',
  bounce: 'Bounced', ooo: 'Out of office', unclassified: 'Not classified', none: 'No reply',
};

export const pad = (n) => String(n).padStart(3, '0');

// In the viewer's own time zone (the backend sends UTC).
// mode: 'full' "Apr 20, 2024, 10:15 AM" | 'table' "Apr 20, 2024 10:15 AM" | 'date' "Apr 20, 2024"
export function fmtDate(iso, mode = 'full') {
  if (!iso) return '—';
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (mode === 'date') return date;
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return mode === 'table' ? `${date} ${time}` : `${date}, ${time}`;
}

// Whole days between an ISO time and now (0 = less than a day ago).
export const daysSince = (iso) => (iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)) : 0);

export const toneOf = (t) => ({ Running: 'green', Delivered: 'green', Replied: 'green', Posted: 'green', Responded: 'green', Interested: 'green', Paused: 'amber', Stopped: 'gray', Offline: 'red', 'Needs review': 'amber', Awaiting: 'amber', Sent: 'blue', 'Not Sent': 'gray', 'Not Posted': 'amber', Failed: 'red', 'Not interested': 'red', Unsubscribed: 'red', Bounced: 'red' }[t] || 'gray');

// Where the agent found a lead (backend /leads `source`): web search or one of its job-board feeds
// (Marketing-AI-Agent config/sources.yaml).
const SOURCE_LABELS = {
  search: 'Web search', company_search: 'Company search', hn_hiring: 'HN Hiring', remoteok: 'RemoteOK',
  remotive: 'Remotive', weworkremotely: 'We Work Remotely', arbeitnow: 'Arbeitnow', jobicy: 'Jobicy',
  himalayas: 'Himalayas', themuse: 'The Muse', adzuna: 'Adzuna', jooble: 'Jooble', feed: 'RSS feed', other: 'Other',
};
// A source added to the agent later still reads well: 'new_board' -> 'New board'.
export const sourceLabel = (key) => SOURCE_LABELS[key]
  || (key ? key.replace(/[_:]+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase()) : 'Other');
