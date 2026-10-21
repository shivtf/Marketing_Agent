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

// The bucket is created on first use (private: only the server's service key can read or write it).
export async function storage() {
  const client = adminClient();
  const { error } = await client.storage.getBucket(BUCKET);
  if (error) {
    const { error: createError } = await client.storage.createBucket(BUCKET, { public: false });
    if (createError && !/already exists/i.test(createError.message)) throw new Error(`Could not create the ${BUCKET} bucket: ${createError.message}`);
  }
  return client.storage.from(BUCKET);
}

// One stored file -> { text, blogs (with raw and hash) } or { problem } when it can't be read.
export async function readFile(bucket, name) {
  const { data, error } = await bucket.download(name);
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
