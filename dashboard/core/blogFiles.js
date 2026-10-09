// Weekly blog files in Supabase Storage (app/api/blogs/weekly-files/route.js).
import { authFetch } from './auth';

const PATH = '/api/blogs/weekly-files';

// -> [{ name: '12_10_26-17_10_26.json', size, updatedAt }] newest week first
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
