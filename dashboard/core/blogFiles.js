// Weekly blog files in Supabase Storage (app/api/blogs/weekly-files/route.js).
import { authFetch } from './auth';

const PATH = '/api/blogs/weekly-files';

// -> [{ name: '12_10_26-17_10_26.json', size, updatedAt, blogs: [{ id, topic, category, publishDate, ... }] | null,
//       problem }] newest week first (blogs without their content; null for older weeks)
export const listWeeklyFiles = () => authFetch(PATH);

// -> { name, text }
export const getWeeklyFile = (name) => authFetch(`${PATH}?name=${encodeURIComponent(name)}`);

// week: that week's Monday, 'YYYY-MM-DD'. Fails with status 409 when the week already has a file and `replace` is false.
export const uploadWeeklyFile = (week, text, replace = false) => authFetch(PATH, {
  method: 'POST',
  body: JSON.stringify({ week, text, replace }),
});

const ymd = (d) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
const ddmmyy = (d) => [d.getDate(), d.getMonth() + 1, d.getFullYear() % 100].map((n) => String(n).padStart(2, '0')).join('_');
const short = (d) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

// The Monday of a file's week: '12_10_26-17_10_26.json' -> '2026-10-12'.
export const fileMonday = (name) => { const [d, m, y] = name.slice(0, 8).split('_'); return `20${y}-${m}-${d}`; };

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
