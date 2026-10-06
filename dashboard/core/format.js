// Small formatting helpers shared by every page and the drawer.
// Reply labels from the reply classifier (replies.label), as shown in the dashboard.
export const REPLY_LABELS = {
  interested: 'Interested', question: 'Question', not_interested: 'Not interested',
  ooo: 'Out of office', bounce: 'Bounced', unsubscribe: 'Unsubscribed',
};

export const pad = (n) => String(n).padStart(3, '0');

// mode: 'full' "Apr 20, 2024, 10:15 AM" | 'table' "Apr 20, 2024 10:15 AM" | 'date' "Apr 20, 2024"
export function fmtDate(iso, mode = 'full') {
  if (!iso) return '—';
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  if (mode === 'date') return date;
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
  return mode === 'table' ? `${date} ${time}` : `${date}, ${time}`;
}

// Whole days between an ISO time and now (0 = less than a day ago).
export const daysSince = (iso) => (iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)) : 0);

export const toneOf = (t) => ({ Running: 'green', Delivered: 'green', Replied: 'green', Posted: 'green', Responded: 'green', Interested: 'green', Paused: 'amber', 'Needs review': 'amber', Awaiting: 'amber', 'Not Posted': 'amber', Failed: 'red', 'Not interested': 'red', Unsubscribed: 'red' }[t] || 'gray');

export const SOURCES = {
  linkedin: { label: 'LinkedIn', icon: 'linkedin', color: '#2f6fed' },
  x: { label: 'X', icon: 'x', color: 'var(--src-x)' },
  other: { label: 'Other', icon: 'other', color: '#b8bccb' },
};
