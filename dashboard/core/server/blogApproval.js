// Approving blogs before they are posted (Blogs page; table blog_approval, migration 010, whose header is the
// contract for the publishing backend). A blog is waiting until an admin approves or rejects it. A decision is for the
// blog exactly as it was then: it is stored with a copy of the blog and its hash, so a blog changed by a replaced file
// waits for a new decision, and the publishing backend posts the approved copy. No database or Storage here, only the
// rules, so `node --test` can load it (core/server/blogApproval.test.mjs).
import { createHash } from 'node:crypto';
import { isDay, readBlogs } from '../weeklyBlogs.js';

// JSON with object keys sorted, so the same blog always gives the same text whatever order its keys were written in.
const stable = (v) => {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
};

// sha256 (hex) of one blog as written in the file.
export const blogHash = (raw) => createHash('sha256').update(stable(raw)).digest('hex');

// Parsed file -> { blogs } as readBlogs gives them, each with `raw` (the blog as written in the file) and its `hash`;
// or { error }.
export function blogsWithHash(json) {
  const read = readBlogs(json);
  if (read.error) return read;
  return { blogs: read.blogs.map((b) => { const raw = json.blogs[b.n - 1]; return { ...b, raw, hash: blogHash(raw) }; }) };
}

// A blog's approval from its row (or none): { status: 'waiting' | 'approved' | 'rejected', by?, at?, reason? }.
// A decision made on another version of the blog doesn't count: the blog waits again, with that one as `earlier`.
export function approvalOf(hash, row) {
  if (!row) return { status: 'waiting' };
  const decision = { status: row.status, by: row.decided_by, at: row.decided_at, reason: row.reason || '' };
  return row.blog_hash === hash ? decision : { status: 'waiting', earlier: decision };
}

// When a file is replaced: the ids of its approved blogs that are gone or changed. Their rows are deleted, so the
// publishing backend can't post an old version (rejections are kept: they are never posted).
export function staleApprovals(rows, blogs) {
  const now = new Map(blogs.filter((b) => b.id).map((b) => [b.id, b.hash]));
  return rows.filter((r) => r.status === 'approved' && now.get(r.blog_id) !== r.blog_hash).map((r) => r.blog_id);
}

// An admin's decisions on blogs of one file -> { upserts: rows to write, clear: ids back to waiting, problems, changed }.
// Each decision: { id, status: 'approved' | 'rejected' | 'waiting', reason?, hash }, `hash` being the version the admin
// looked at. All or nothing: any problem means nothing is written. `changed`: the file was replaced meanwhile.
// `today` is 'YYYY-MM-DD': a blog whose date has passed can't be approved any more. `locked`: ids of blogs posted or
// being posted (blog_posts, a Dev.to draft aside), whose decision can't change any more.
export function planDecisions({ fileName, blogs, decisions, by, today, locked = new Set(), now = new Date() }) {
  const out = { upserts: [], clear: [], problems: [], changed: false };
  if (!Array.isArray(decisions) || !decisions.length) {
    out.problems.push({ id: '', message: 'No blogs to decide on.' });
    return out;
  }
  const uses = {};
  for (const b of blogs) if (b.id) uses[b.id] = (uses[b.id] || 0) + 1;
  const problem = (id, message) => out.problems.push({ id, message });
  for (const d of decisions) {
    const id = typeof d?.id === 'string' ? d.id : '';
    const blog = id ? blogs.find((b) => b.id === id) : null;
    if (!blog) { problem(id || '(no id)', 'This blog is not in the file.'); continue; }
    if (uses[id] > 1) { problem(id, 'This id is used more than once in the file: fix the file first.'); continue; }
    if (d.hash !== blog.hash) {
      out.changed = true;
      problem(id, 'The file was replaced since you opened it: look at the blog again.');
      continue;
    }
    if (locked.has(id)) { problem(id, 'It is already posted (or being posted): its approval can\'t change.'); continue; }
    if (d.status === 'waiting') { out.clear.push(id); continue; }
    if (d.status !== 'approved' && d.status !== 'rejected') { problem(id, 'Unknown decision.'); continue; }
    const reason = typeof d.reason === 'string' ? d.reason.trim() : '';
    if (d.status === 'rejected' && !reason) { problem(id, 'Say why it is rejected.'); continue; }
    if (d.status === 'approved') {
      if (!isDay(blog.publishDate)) { problem(id, 'Its publish_date is not a real date: fix the file first.'); continue; }
      if (blog.publishDate < today) { problem(id, `Its date (${blog.publishDate}) has passed.`); continue; }
    }
    out.upserts.push({
      file_name: fileName,
      blog_id: id,
      status: d.status,
      blog: blog.raw,
      blog_hash: blog.hash,
      publish_date: isDay(blog.publishDate) ? blog.publishDate : null,
      reason: d.status === 'rejected' ? reason : null,
      decided_by: by,
      decided_at: now.toISOString(),
    });
  }
  return out;
}

// A blog's post from its blog_posts row (or none): { status: 'posting' | 'posted' | 'failed', draft, url, error, at }.
export function postOf(row) {
  if (!row) return null;
  return { status: row.status, draft: !!row.draft, url: row.url || '', error: row.error || '', at: row.posted_at || row.started_at };
}

// Posted or being posted, for real: such a blog's approval can't change (a Dev.to draft doesn't count).
export const isLocked = (row) => !!row && (row.status === 'posting' || (row.status === 'posted' && !row.draft));
