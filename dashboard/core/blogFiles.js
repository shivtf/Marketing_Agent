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

// The week is read from the blogs' dates (the server checks it again). Fails with status 409 when that week already has
// a file and `replace` is false.
export const uploadWeeklyFile = (text, replace = false) => authFetch(PATH, {
  method: 'POST',
  body: JSON.stringify({ text, replace }),
});

const short = (d) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

// Approve, reject (with a reason) or take back blogs of one file. decisions: [{ id, status: 'approved' | 'rejected' |
// 'waiting', reason?, hash }], `hash` being the version on screen. -> { approvals: { [blog id]: approval } }.
// Fails with status 409 when the file was replaced since it was read.
export const decideBlogs = (name, decisions) => authFetch('/api/blogs/approvals', {
  method: 'POST',
  body: JSON.stringify({ name, decisions }),
});

// Take one blog out of a weekly file, and its approval, so it is never posted (admins). `hash`: the version on screen.
// -> { name, removed }. Fails with status 409 when the file was replaced since it was read.
export const removeBlog = (name, id, hash) => authFetch(PATH, {
  method: 'DELETE',
  body: JSON.stringify({ name, id, hash }),
});

// '26_10_26-31_10_26.json' -> 'Mon, Oct 26 – Sat, Oct 31, 2026'
export function weekLabel(name) {
  const [d1, m1, y1, d2, m2, y2] = name.slice(0, 17).split(/[_-]/).map(Number);
  const mon = new Date(Date.UTC(2000 + y1, m1 - 1, d1));
  const sat = new Date(Date.UTC(2000 + y2, m2 - 1, d2));
  return `${short(mon)} – ${short(sat)}, ${sat.getUTCFullYear()}`;
}
