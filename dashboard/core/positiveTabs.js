// Positive Leads, one row per person (components/PositiveLeadsView.js). The backend lists every reply written by a
// person on its own, in its group (/leads/positive: positive, review, questions, notInterested, unsubscribe); here each
// lead's newest reply decides which tab they are in, and the tabs say what to do next. Their earlier replies stay
// reachable from the drawer.
import { REPLY_LABELS, toneOf } from './format.js';

export const TABS = [
  { key: 'reply', label: 'Reply to these', icon: 'mail', empty: 'Nobody is waiting for an answer',
    hint: 'Interested or asked something, and still waiting for your answer. Longest waiting first.' },
  { key: 'check', label: 'Check these', icon: 'alert', empty: 'Nothing to check',
    hint: 'The keywords weren’t sure, or it may ask to stop. Open each one and choose a label.' },
  { key: 'answered', label: 'Answered', icon: 'check', empty: 'No answered replies yet',
    hint: 'We have replied to their latest email.' },
  { key: 'closed', label: 'Closed', icon: 'close', empty: 'Nobody has said no',
    hint: 'Said no or asked to stop: no answer needed. Skim them in case one was misread.' },
];
export const TAB_KEYS = TABS.map((t) => t.key);

const GROUPS = ['positive', 'review', 'questions', 'notInterested', 'unsubscribe'];
export const OVERDUE_DAYS = 3; // waiting this long -> shown in red

// The tab for a person, from their newest reply (r.group: its backend group).
export function tabOf(r) {
  if (r.group === 'notInterested') return 'closed';
  // A person's Unsubscribe label is final; one the keywords only suspect needs a person to confirm it.
  if (r.group === 'unsubscribe') return r.labelledByPerson ? 'closed' : 'check';
  if (r.followUp === 'replied') return 'answered';
  if (r.group === 'review') return 'check';
  return 'reply'; // positive, questions
}

const newestFirst = (a, b) => b.repliedAt.localeCompare(a.repliedAt);
const oldestFirst = (a, b) => a.repliedAt.localeCompare(b.repliedAt);

// Every reply of one lead, newest first, each with its group.
export function repliesOf(data, leadId) {
  return GROUPS.flatMap((group) => (data[group] || []).filter((r) => r.leadId === leadId).map((r) => ({ ...r, group })))
    .sort(newestFirst);
}

// /leads/positive -> { reply, check, answered, closed }: one row per lead (their newest reply, plus `earlier`: their
// older replies, newest first). Reply / Check: longest waiting first; Answered / Closed: newest reply first.
export function byPerson(data) {
  const byLead = new Map();
  for (const group of GROUPS) {
    for (const r of data[group] || []) {
      if (!byLead.has(r.leadId)) byLead.set(r.leadId, []);
      byLead.get(r.leadId).push({ ...r, group });
    }
  }
  const tabs = Object.fromEntries(TAB_KEYS.map((k) => [k, []]));
  for (const rows of byLead.values()) {
    rows.sort(newestFirst);
    const row = { ...rows[0], earlier: rows.slice(1) };
    tabs[tabOf(row)].push(row);
  }
  for (const k of TAB_KEYS) tabs[k].sort(k === 'reply' || k === 'check' ? oldestFirst : newestFirst);
  return tabs;
}

const CALL = /\b(call|talk|chat|meet|meeting|schedule|demo|times?|slots?|calendar|available|availability)\b/i;
const PRICE = /\b(price|prices|pricing|cost|costs|quote|budget|how much)\b/i;
const DETAILS = /\b(details|info|information|brochure|deck|case stud(y|ies)|send (me|us|over))\b/i;
const REVIEW = [
  [/^Asks to be contacted later/, 'Contact later'],
  [/^Points you to someone else/, 'Points to someone else'],
  [/says both yes and no/, 'Mixed yes and no'],
  [/only a soft no/, 'Soft no'],
];

// Why a reply is where it is, in plain words -> { text, tone, title } (title: the detail behind it, for a tooltip).
// Only for display: the group itself comes from the backend (a person's label, else the keyword score).
export function whyOf(r) {
  const detail = r.reviewReason || (r.scoreHits?.length
    ? `Matched: ${r.scoreHits.map((h) => `“${h.phrase}”`).join(', ')}` : 'No keywords matched');
  if (r.labelledByPerson) {
    const text = REPLY_LABELS[r.label] || r.label;
    return { text, tone: toneOf(text), title: 'Labelled by a person' };
  }
  const words = `${(r.scoreHits || []).filter((h) => h.weight > 0).map((h) => h.phrase).join(' ')} ${r.preview || ''}`;
  switch (r.group) {
    case 'positive':
      if (CALL.test(words)) return { text: 'Wants a call', tone: 'green', title: detail };
      if (PRICE.test(words)) return { text: 'Wants pricing', tone: 'green', title: detail };
      if (DETAILS.test(words)) return { text: 'Wants details', tone: 'green', title: detail };
      return { text: 'Interested', tone: 'green', title: detail };
    case 'questions':
      return { text: PRICE.test(r.preview || '') ? 'Asked a price' : 'Asked a question', tone: 'blue', title: detail };
    case 'review': {
      const hit = REVIEW.find(([rx]) => rx.test(r.reviewReason || ''));
      return hit ? { text: hit[1], tone: 'amber', title: detail } : { text: 'Unclear', tone: 'gray', title: detail };
    }
    case 'notInterested':
      return { text: 'Said no', tone: 'red', title: detail };
    case 'unsubscribe':
      return { text: 'May want to stop', tone: 'red', title: detail };
    default:
      return { text: 'Unclear', tone: 'gray', title: detail };
  }
}
