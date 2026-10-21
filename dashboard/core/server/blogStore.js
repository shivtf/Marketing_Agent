// Weekly blog files in Supabase Storage (bucket blog-plans), their approvals (table blog_approval, migration 010) and
// what the backend posted (table blog_posts, migration 011: written by dashboardbackend/app/blog_posts.py, read here).
// Used by app/api/blogs/weekly-files and app/api/blogs/approvals. The rules themselves are in blogApproval.js.
import 'server-only';
import { adminClient } from './supabaseAdmin';
import { blogsWithHash } from './blogApproval';

export const BUCKET = 'blog-plans';
export const NAME = /^\d{2}_\d{2}_\d{2}-\d{2}_\d{2}_\d{2}\.json$/;
const TABLE = 'blog_approval';
const POSTS = 'blog_posts';
// Saving a weekly file: never cached, since it is overwritten (replaced, or a blog removed).
export const SAVE = { contentType: 'application/json', cacheControl: '0' };

// The bucket is created on first use (private: only the server's service key can read or write it). Checked once per
// server process, not on every request: it is never deleted by the dashboard.
let bucketReady = null;
export async function storage() {
  const client = adminClient();
  bucketReady ||= (async () => {
    const { error } = await client.storage.getBucket(BUCKET);
    if (!error) return;
    const { error: createError } = await client.storage.createBucket(BUCKET, { public: false });
    if (createError && !/already exists/i.test(createError.message)) throw new Error(`Could not create the ${BUCKET} bucket: ${createError.message}`);
  })().catch((err) => { bucketReady = null; throw err; }); // a failed check is tried again next time
  await bucketReady;
  return client.storage.from(BUCKET);
}

// One stored file -> { text, blogs (with raw and hash) } or { problem } when it can't be read. Always the current
// version: Supabase's CDN keeps a copy of a file after it is overwritten, and an old copy read here would bring back a
// blog just removed (the next save writes it back). The nonce makes every read reach the file itself.
export async function readFile(bucket, name) {
  const { data, error } = await bucket.download(name, { cacheNonce: `${Date.now()}-${Math.random().toString(36).slice(2)}` });
  if (error) return { problem: 'Could not read the file.', missing: true };
  const text = await data.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { problem: 'The file is not valid JSON.' };
  }
  const read = blogsWithHash(json);
  return read.error ? { problem: read.error } : { text, blogs: read.blogs };
}

// The schedule's read: a file is downloaded again only when it changed (`updatedAt` from the bucket listing, which is
// always current), else this server's last copy is used. The page opens without downloading every week each time.
// Writes never use this: they read the file itself (readFile).
const cache = new Map(); // name -> { updatedAt, file }
export async function readFileCached(bucket, name, updatedAt) {
  const hit = cache.get(name);
  if (hit && updatedAt && hit.updatedAt === updatedAt) return hit.file;
  const file = await readFile(bucket, name);
  cache.delete(name);
  if (!file.problem && updatedAt) {
    cache.set(name, { updatedAt, file });
    if (cache.size > 64) cache.delete(cache.keys().next().value); // the oldest entry
  }
  return file;
}

// The decisions made on these files' blogs.
export async function approvalRows(names) {
  if (!names.length) return [];
  const { data, error } = await adminClient().from(TABLE)
    .select('file_name, blog_id, status, blog_hash, reason, decided_by, decided_at')
    .in('file_name', names);
  if (error) throw new Error(`Could not read blog approvals (is migration 010 applied?): ${error.message}`);
  return data;
}

export async function saveDecisions(name, upserts, clear) {
  const table = adminClient().from(TABLE);
  if (upserts.length) {
    const { error } = await table.upsert(upserts, { onConflict: 'file_name,blog_id' });
    if (error) throw new Error(`Could not save the approvals: ${error.message}`);
  }
  if (clear.length) await deleteApprovals(name, clear);
}

export async function deleteApprovals(name, ids) {
  const { error } = await adminClient().from(TABLE).delete().eq('file_name', name).in('blog_id', ids);
  if (error) throw new Error(`Could not clear the approvals: ${error.message}`);
}

// What the backend posted of these files' blogs: [{ file_name, blog_id, status, draft, url, error, posted_at }].
export async function postRows(names) {
  if (!names.length) return [];
  const { data, error } = await adminClient().from(POSTS)
    .select('file_name, blog_id, status, draft, url, error, started_at, posted_at')
    .in('file_name', names);
  if (error) throw new Error(`Could not read blog posts (is migration 011 applied?): ${error.message}`);
  return data;
}

// When a blog is removed from its file: forget its unfinished posts (a failed attempt, or a Dev.to draft from a test),
// so it no longer shows in the Blog Tracker. A real post is never removed (the route refuses those blogs).
export async function deleteUnfinishedPosts(name, id) {
  const { error } = await adminClient().from(POSTS).delete().eq('file_name', name).eq('blog_id', id)
    .or('status.eq.failed,and(status.eq.posted,draft.is.true)');
  if (error) throw new Error(`Could not clear its unfinished posts: ${error.message}`);
}
