// Small formatting helpers shared by every page and the drawer.
// Reply labels from the reply classifier (replies.label), as shown in the dashboard.
export const REPLY_LABELS = {
  interested: 'Interested', question: 'Question', not_interested: 'Not interested',
  ooo: 'Out of office', bounce: 'Bounced', unsubscribe: 'Unsubscribed',
};


export const pad = (n) => String(n).padStart(3, '0');

// In the viewer's own time zone (the backend sends UTC).
// mode: 'full' "Apr 20, 2024, 10:15 AM" | 'table' "Apr 20, 2024 10:15 AM" | 'date' "Apr 20, 2024"
// A time with no zone ("2026-10-07T05:12:38") is UTC like every time the backend sends; without the "Z" the
// browser would read it as local time.
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;
export function fmtDate(iso, mode = 'full') {
  if (!iso) return '—';
  const d = new Date(typeof iso === 'string' && iso.includes('T') && !HAS_ZONE.test(iso) ? `${iso}Z` : iso);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (mode === 'date') return date;
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return mode === 'table' ? `${date} ${time}` : `${date}, ${time}`;
}

// A calendar date ("2026-10-12", no time) in the viewer's language: 'day' "Mon, Oct 12", 'long' "Monday, Oct 12, 2026".
// Built from its parts, so it never shifts a day the way new Date("2026-10-12") (midnight UTC) does west of UTC.
export function fmtDay(ymd, mode = 'day') {
  if (!ymd) return '—';
  const [y, m, d] = ymd.split('-').map(Number);
  const opts = mode === 'long'
    ? { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }
    : { weekday: 'short', month: 'short', day: 'numeric' };
  return new Date(y, m - 1, d).toLocaleDateString('en-US', opts);
}

// The Monday of a calendar date's week, as "YYYY-MM-DD".
export function weekOf(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const day = new Date(y, m - 1, d);
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return [day.getFullYear(), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0')].join('-');
}

// Blog plan status (backend /blogs/plan) as shown in the dashboard.
export const PLAN_STATUS = { planned: 'Planned', written: 'Written', posted: 'Posted', missed: 'Missed', cancelled: 'Cancelled' };

// Whole days between an ISO time and now (0 = less than a day ago).
export const daysSince = (iso) => (iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)) : 0);

export const toneOf = (t) => ({ Running: 'green', Delivered: 'green', Replied: 'green', Posted: 'green', Responded: 'green', Interested: 'green', Paused: 'amber', Stopped: 'gray', Offline: 'red', 'Needs review': 'amber', Awaiting: 'amber', Planned: 'blue', Written: 'amber', Missed: 'red', Cancelled: 'gray', Sent: 'blue', 'Not Sent': 'gray', 'Not Posted': 'amber', Failed: 'red', 'Not interested': 'red', Unsubscribed: 'red', Bounced: 'red' }[t] || 'gray');

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
