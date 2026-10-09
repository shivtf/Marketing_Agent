// Reading a weekly blog file (the JSON stored in Supabase Storage, app/api/blogs/weekly-files/route.js). Used by the
// server (schedule) and the browser (check before upload), so it has no imports. The file looks like:
//   { "blogs": [ { "id": "BLG-001", "topic": "...", "category": "HAL", "keywords": [...], "publish_date": "2026-10-12",
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
      topic: text(o.topic),
      category: text(o.category),
      keywords: list(o.keywords),
      publishDate: text(o.publish_date),
      tone: text(o.tone),
      length: text(o.length),
      targetVersions: list(o.target_versions),
      referenceUrls: list(o.reference_urls),
      contentFormat: text(o.content_format),
      content: typeof o.content === 'string' ? o.content : '',
    };
  });
  blogs.sort((a, b) => (a.publishDate || '9999').localeCompare(b.publishDate || '9999') || a.n - b.n);
  return { blogs };
}

const isDay = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; // 2026-02-30 rolls over: not a real day
};
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

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
    if (!b.topic) errors.push({ id: who, message: 'Missing topic.' });
    if (!isDay(b.publishDate)) errors.push({ id: who, message: 'publish_date must be a real date written as YYYY-MM-DD.' });
    else if (b.publishDate < monday || b.publishDate > saturday) {
      errors.push({ id: who, message: `${b.publishDate} is not in this week (${monday} to ${saturday}).` });
    } else days[b.publishDate] = (days[b.publishDate] || 0) + 1;
    if (!b.content.trim()) warnings.push({ id: who, message: 'No content: the blog text is empty.' });
  }
  for (const [day, count] of Object.entries(days)) {
    if (count > 1) warnings.push({ id: '', message: `${count} blogs are on ${day}.` });
  }
  return { errors, warnings };
}
