// Weekly blog files: the JSON for one week (Monday to Saturday), stored as is in Supabase Storage, bucket
// "blog-plans", named by its week, e.g. 12_10_26-17_10_26.json. Another backend picks the file up from the bucket;
// here the blogs inside are read to show which blog goes out on which day (core/weeklyBlogs.js), and whether an admin
// approved it: the publishing backend posts approved blogs only (app/api/blogs/approvals, core/server/blogApproval.js).
//   GET                 -> [{ name, size, updatedAt, blogs, problem, approvalProblem }] newest week first (any signed-in
//                          user). `blogs` (no content; each with `hash`, `approval` and `post`) for the newest
//                          SCHEDULE_WEEKS files, null for older ones. approvalProblem: approvals couldn't be read
//                          (approval: null). `post`: what the backend posted (blog_posts, migration 011), else null.
//   GET ?name=<file>    -> { name, text, approvals: { [blog id]: { hash, approval, post } } } (any signed-in user)
//   POST { week, text, replace } -> { name, replaced, unapproved } (admins; week = that week's Monday, "YYYY-MM-DD",
//                          not over yet). The file must pass checkUpload (core/weeklyBlogs.js), else 400
//                          { error, problems }. Replacing a file takes back the approvals of blogs it changes or drops
//                          (`unapproved`: their ids).
import { getCaller, requireAdmin, fail, handle } from '@/core/server/supabaseAdmin';
import { approvalOf, blogsWithHash, postOf, staleApprovals } from '@/core/server/blogApproval';
import { BUCKET, NAME, approvalRows, deleteApprovals, postRows, readFile, storage } from '@/core/server/blogStore';
import { checkUpload } from '@/core/weeklyBlogs';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 5 * 1024 * 1024;
const SCHEDULE_WEEKS = 12; // newest files read for the schedule; older ones are listed only

const ddmmyy = (d) => [d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCFullYear() % 100].map((n) => String(n).padStart(2, '0')).join('_');

// "2026-10-12" (a Monday) -> "12_10_26-17_10_26.json"; null when it isn't a real Monday.
function fileName(week) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week || '')) return null;
  const monday = new Date(`${week}T00:00:00Z`);
  if (Number.isNaN(monday.getTime()) || monday.toISOString().slice(0, 10) !== week || monday.getUTCDay() !== 1) return null;
  const saturday = new Date(monday.getTime() + 5 * 86400000);
  return `${ddmmyy(monday)}-${ddmmyy(saturday)}.json`;
}

// Sorts by the Monday in the name (DD_MM_YY), newest first.
const weekKey = (name) => { const [d, m, y] = name.slice(0, 8).split('_'); return `${y}${m}${d}`; };

async function listFiles(bucket) {
  const { data, error } = await bucket.list('', { limit: 1000 });
  if (error) throw new Error(`Could not list ${BUCKET}: ${error.message}`);
  return data
    .filter((f) => NAME.test(f.name))
    .map((f) => ({ name: f.name, size: f.metadata?.size ?? null, updatedAt: f.updated_at || f.created_at }))
    .sort((a, b) => weekKey(b.name).localeCompare(weekKey(a.name)));
}

const key = (file, id) => `${file}\n${id}`;

// The approvals of these files' blogs, by file and blog id; null when they can't be read (migration 010 not applied).
async function approvalsOf(names) {
  try {
    return new Map((await approvalRows(names)).map((r) => [key(r.file_name, r.blog_id), r]));
  } catch (err) {
    console.error('[api]', err.message);
    return null;
  }
}
// What the backend posted of these files' blogs, by file and blog id (empty before migration 011: nothing posted).
async function postsOf(names) {
  try {
    return new Map((await postRows(names)).map((r) => [key(r.file_name, r.blog_id), r]));
  } catch (err) {
    console.error('[api]', err.message);
    return new Map();
  }
}
const NO_APPROVALS = 'Approvals could not be read, so nothing here can be approved (is migration 010 applied?).';

// The blogs in one file, without their text (the schedule only needs dates and topics), each with its approval.
function schedule(name, file, approvals, posts) {
  if (file.problem) return { blogs: null, problem: file.problem };
  return {
    blogs: file.blogs.map(({ content, raw, ...b }) => ({
      ...b,
      hasContent: !!content.trim(),
      approval: approvals && b.id ? approvalOf(b.hash, approvals.get(key(name, b.id))) : null,
      post: b.id ? postOf(posts.get(key(name, b.id))) : null,
    })),
    problem: null,
  };
}

export const GET = handle(async (request) => {
  const { error } = await getCaller(request);
  if (error) return error;
  const bucket = await storage();
  const name = new URL(request.url).searchParams.get('name');
  if (name === null) {
    const files = await listFiles(bucket);
    const recent = files.slice(0, SCHEDULE_WEEKS);
    const names = recent.map((f) => f.name);
    const [read, approvals, posts] = await Promise.all([
      Promise.all(recent.map((f) => readFile(bucket, f.name))),
      approvalsOf(names),
      postsOf(names),
    ]);
    const approvalProblem = approvals ? null : NO_APPROVALS;
    return Response.json(files.map((f, i) => ({
      ...f,
      ...(read[i] ? schedule(f.name, read[i], approvals, posts) : { blogs: null, problem: null }),
      approvalProblem,
    })));
  }
  if (!NAME.test(name)) return fail('Unknown file.', 404);
  const file = await readFile(bucket, name);
  if (file.missing) return fail('File not found.', 404);
  if (file.problem) return fail(`Couldn't read ${name}: ${file.problem}`, 422);
  const [approvals, posts] = await Promise.all([approvalsOf([name]), postsOf([name])]);
  const byId = {};
  for (const b of file.blogs) {
    if (!b.id) continue;
    byId[b.id] = {
      hash: b.hash,
      approval: approvals ? approvalOf(b.hash, approvals.get(key(name, b.id))) : null,
      post: postOf(posts.get(key(name, b.id))),
    };
  }
  return Response.json({ name, text: file.text, approvals: byId, approvalProblem: approvals ? null : NO_APPROVALS });
});

export const POST = handle(async (request) => {
  const { error } = await requireAdmin(request);
  if (error) return error;
  const body = await request.json().catch(() => ({}));
  const name = fileName(body.week);
  if (!name) return fail('Pick the week (its Monday).', 400);
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) return fail('The file is empty.', 400);
  if (new TextEncoder().encode(text).length > MAX_BYTES) return fail('The file is larger than 5 MB.', 413);
  // The same check the page runs before showing the preview: a file sent past the page must pass it too.
  const check = checkUpload(text, body.week);
  if (check.error) return fail(check.error, 400);
  if (check.errors.length) {
    const [first] = check.errors;
    const more = check.errors.length > 1 ? ` (and ${check.errors.length - 1} more)` : '';
    return Response.json({ error: `${first.id ? `${first.id}: ` : ''}${first.message}${more}`, problems: check.errors },
      { status: 400 });
  }

  const bucket = await storage();
  const exists = (await listFiles(bucket)).some((f) => f.name === name);
  if (exists && body.replace !== true) return Response.json({ error: `${name} already exists.`, exists: true, name }, { status: 409 });
  // Approvals of blogs this file changes or drops are taken back first, so the publishing backend can't post a version
  // nobody approved for this file. Done before saving: if the save then fails, the worst case is blogs waiting again.
  let unapproved;
  try {
    unapproved = staleApprovals(await approvalRows([name]), blogsWithHash(JSON.parse(text)).blogs);
    if (unapproved.length) await deleteApprovals(name, unapproved);
  } catch (err) {
    console.error('[api]', err.message);
    return fail(`Could not check the approvals of ${name}, so it was not saved (is migration 010 applied?).`, 503);
  }
  const { error: err } = await bucket.upload(name, new Blob([text], { type: 'application/json' }), {
    contentType: 'application/json',
    upsert: exists,
  });
  if (err) return fail(`Could not save ${name}: ${err.message}`, 500);
  return Response.json({ name, replaced: exists, unapproved }, { status: exists ? 200 : 201 });
});
