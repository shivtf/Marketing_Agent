// Reading a weekly blog file (the JSON stored in Supabase Storage, app/api/blogs/weekly-files/route.js). Used by the
// server (schedule) and the browser (check before upload), so it has no imports. The file looks like:
//   { "blogs": [ { "id": "BLG-001", "title": "...", "topic": "...", "category": "HAL", "keywords": [...], "publish_date": "2026-10-12",
//                  "tone": "...", "length": "...", "target_versions": [...], "reference_urls": [...],
//                  "content_format": "markdown", "content": "# ..." } ] }

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);

// Parsed JSON -> { blogs: [...] } sorted by date, or { error } when there is no "blogs" list.
export function readBlogs(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.blogs)) return { error: 'The file has no "blogs" list.' };
  const blogs = json.blogs.map((b, i) => {
    const o = b && typeof b === 'object' ? b : {};
    return {
      n: i + 1, // position in the file, for blogs without an id
      id: text(o.id),
      title: text(o.title), // the headline on Dev.to (older files have only a topic)
      topic: text(o.topic),
      category: text(o.category),
      keywords: list(o.keywords),
      publishDate: text(o.publish_date),
      tone: text(o.tone),
      length: text(o.length),
      targetVersions: list(o.target_versions),
      referenceUrls: [...new Set([...list(o.reference_urls), ...list([o.reference_url])])], // a list, or one url
      contentFormat: text(o.content_format),
      content: typeof o.content === 'string' ? o.content : '',
    };
  });
  blogs.sort((a, b) => (a.publishDate || '9999').localeCompare(b.publishDate || '9999') || a.n - b.n);
  return { blogs };
}

// The blog a schedule row points to, in the file as it is now. By id: positions move when a file is replaced. A blog
// without an id (files saved before ids were required) only by its position, and only while its topic is the same.
// -> { blog, changed } (changed: its topic or date is no longer what the row showed), or null when it is gone.
export const headline = (b) => b.title || b.topic; // what the blog is called on Dev.to

export function findBlog(blogs, row) {
  const blog = row.id
    ? blogs.find((b) => b.id === row.id)
    : blogs.find((b) => b.n === row.n && !b.id && b.topic === row.topic);
  if (!blog) return null;
  return { blog, changed: blog.topic !== row.topic || blog.publishDate !== row.publishDate };
}

export const isDay = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; // 2026-02-30 rolls over: not a real day
};
export const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// Which day it is for blogs, everywhere (page, Vercel, backend): India time. The backend's BLOG_TIMEZONE must say the
// same (its default). Without one clock, the hours after midnight in India were "yesterday" on Vercel (UTC).
export const BLOG_TIMEZONE = 'Asia/Kolkata';
const dayIn = new Intl.DateTimeFormat('en-CA', { timeZone: BLOG_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
export const blogToday = (now = new Date()) => dayIn.format(now); // 'YYYY-MM-DD'

// A blog whose posting failed, or that nobody posted on its day, can still be posted this many days after its date
// (the backend's LATE_DAYS, app/blog_posts.py).
export const LATE_DAYS = 3;
// The last day a blog dated `ymd` can still be approved and posted.
export const lastPostDay = (ymd) => addDays(ymd, LATE_DAYS);

// Problems with a file uploaded for the week starting `monday` ('YYYY-MM-DD'). Errors stop the upload; warnings
// don't. -> { errors: [{ id, message }], warnings: [{ id, message }] }
export function checkWeek(blogs, monday) {
  const errors = [];
  const warnings = [];
  const saturday = addDays(monday, 5);
  if (!blogs.length) errors.push({ id: '', message: 'The "blogs" list is empty.' });
  const ids = {};
  const days = {};
  for (const b of blogs) {
    const who = b.id || `Blog #${b.n}`;
    if (!b.id) errors.push({ id: who, message: 'Missing id.' });
    else if (ids[b.id]) errors.push({ id: who, message: 'This id is used more than once.' });
    ids[b.id] = true;
    if (!b.topic && !b.title) errors.push({ id: who, message: 'Missing title (or topic).' });
    if (!isDay(b.publishDate)) errors.push({ id: who, message: 'publish_date must be a real date written as YYYY-MM-DD.' });
    else if (b.publishDate === addDays(monday, 6)) {
      errors.push({ id: who, message: `${b.publishDate} is a Sunday: a week is Monday to Saturday.` });
    } else if (b.publishDate < monday || b.publishDate > saturday) {
      errors.push({ id: who, message: `${b.publishDate} is not in this week (${monday} to ${saturday}).` });
    } else days[b.publishDate] = (days[b.publishDate] || 0) + 1;
    if (!b.content.trim()) warnings.push({ id: who, message: 'No content: the blog text is empty.' });
  }
  for (const [day, count] of Object.entries(days)) {
    if (count > 1) warnings.push({ id: '', message: `${count} blogs are on ${day}.` });
  }
  return { errors, warnings };
}

// The Monday of the week a day is in: '2026-10-25' (a Sunday) -> '2026-10-19'.
export const mondayOf = (ymd) => addDays(ymd, -((new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7));

// A week's file name, from its Monday: '2026-10-26' -> '26_10_26-31_10_26.json' (Monday to Saturday).
export function weekFileName(monday) {
  const dmy = (ymd) => `${ymd.slice(8, 10)}_${ymd.slice(5, 7)}_${ymd.slice(2, 4)}`;
  return `${dmy(monday)}-${dmy(addDays(monday, 5))}.json`;
}

// The Monday of the week `today` is in (India time), 'YYYY-MM-DD'.
export function thisMonday(today = new Date()) {
  return mondayOf(blogToday(today));
}

// Which week a file is for, read from its blogs' dates: the Monday of the week most of them are in (the earliest one
// on a tie), and every week found. -> { monday: 'YYYY-MM-DD' | null (no real date), weeks: [Mondays, sorted] }
export function weekOf(blogs) {
  const count = {};
  for (const b of blogs) if (isDay(b.publishDate)) count[mondayOf(b.publishDate)] = (count[mondayOf(b.publishDate)] || 0) + 1;
  const weeks = Object.keys(count).sort();
  const monday = weeks.reduce((best, w) => (best === null || count[w] > count[best] ? w : best), null);
  return { monday, weeks };
}

// The whole check for an uploaded file, run by the browser (to show the preview) and again by the server (before
// saving: the browser's check can be skipped). The week is read from the blogs' dates (weekOf): one file holds one week,
// Monday to Saturday, not over yet. -> { error } when it can't be read at all, else { blogs, errors, warnings, monday,
// fileName } (errors stop the upload; monday / fileName are null when no blog has a real date).
export function checkUpload(text, today = new Date()) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: 'The file is not valid JSON. Check for a missing comma or bracket.' };
  }
  const read = readBlogs(json);
  if (read.error) return read;
  const { monday, weeks } = weekOf(read.blogs);
  if (!monday) {
    const { errors, warnings } = checkWeek(read.blogs, thisMonday(today)); // shows each blog's own problem
    return { blogs: read.blogs, errors, warnings, monday: null, fileName: null };
  }
  const result = { blogs: read.blogs, ...checkWeek(read.blogs, monday), monday, fileName: weekFileName(monday) };
  if (weeks.length > 1) {
    const list = weeks.map((w) => `${w} to ${addDays(w, 5)}`).join(', ');
    result.errors.unshift({ id: '', message: `The blogs are in ${weeks.length} different weeks (${list}): one file holds one week, Monday to Saturday.` });
  }
  if (monday < thisMonday(today)) result.errors.unshift({ id: '', message: `The week of ${monday} is already over.` });
  return result;
}
