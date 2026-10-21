// Weekly blog files in Supabase Storage (app/api/blogs/weekly-files/route.js) and their approvals
// (app/api/blogs/approvals/route.js).
import { authFetch } from './auth';

const PATH = '/api/blogs/weekly-files';

// -> [{ name: '12_10_26-17_10_26.json', size, updatedAt, blogs: [{ id, topic, category, publishDate, hash, approval,
//       ... }] | null, problem, approvalProblem }] newest week first (blogs without their content; null for older weeks).
//    approval: { status: 'waiting' | 'approved' | 'rejected', by, at, reason, earlier? } (null: couldn't be read)
export const listWeeklyFiles = () => authFetch(PATH);

// -> { name, text, approvals: { [blog id]: { hash, approval } }, approvalProblem }
export const getWeeklyFile = (name) => authFetch(`${PATH}?name=${encodeURIComponent(name)}`);

// week: that week's Monday, 'YYYY-MM-DD'. Fails with status 409 when the week already has a file and `replace` is false.
export const uploadWeeklyFile = (week, text, replace = false) => authFetch(PATH, {
  method: 'POST',
  body: JSON.stringify({ week, text, replace }),
});

const ymd = (d) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
const ddmmyy = (d) => [d.getDate(), d.getMonth() + 1, d.getFullYear() % 100].map((n) => String(n).padStart(2, '0')).join('_');
const short = (d) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

// This week and the next few, Monday to Saturday: [{ week: 'YYYY-MM-DD', label, fileName }].
export function weekChoices(count = 5, today = new Date()) {
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7));
  return Array.from({ length: count }, (_, i) => {
    const mon = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7 * i);
    const sat = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 5);
    const when = ['this week', 'next week'][i] || `in ${i} weeks`;
    return { week: ymd(mon), label: `${short(mon)} – ${short(sat)} (${when})`, fileName: `${ddmmyy(mon)}-${ddmmyy(sat)}.json` };
  });
}

// Approve, reject (with a reason) or take back blogs of one file. decisions: [{ id, status: 'approved' | 'rejected' |
// 'waiting', reason?, hash }], `hash` being the version on screen. -> { approvals: { [blog id]: approval } }.
// Fails with status 409 when the file was replaced since it was read.
export const decideBlogs = (name, decisions) => authFetch('/api/blogs/approvals', {
  method: 'POST',
  body: JSON.stringify({ name, decisions }),
});

// '26_10_26-31_10_26.json' -> 'Mon, Oct 26 – Sat, Oct 31, 2026'
export function weekLabel(name) {
  const [d1, m1, y1, d2, m2, y2] = name.slice(0, 17).split(/[_-]/).map(Number);
  const mon = new Date(2000 + y1, m1 - 1, d1);
  const sat = new Date(2000 + y2, m2 - 1, d2);
  return `${short(mon)} – ${short(sat)}, ${sat.getFullYear()}`;
}
