// Weekly blog files: the JSON for one week (Monday to Saturday), stored as is in Supabase Storage, bucket
// "blog-plans", named by its week, e.g. 12_10_26-17_10_26.json. The blogs inside are read to show which blog goes out
// on which day (core/weeklyBlogs.js) and whether an admin approved it (app/api/blogs/approvals). The dashboard backend
// posts approved blogs to Dev.to when an admin clicks Post today's blogs (dashboardbackend/app/blog_posts.py).
//   GET                 -> [{ name, size, updatedAt, blogs, problem, approvalProblem }] newest week first (any signed-in
//                          user). `blogs` (no content; each with `hash`, `approval` and `post`) for the newest
//                          SCHEDULE_WEEKS files, null for older ones. approvalProblem: approvals couldn't be read
//                          (approval: null). `post`: what the backend posted (blog_posts, migration 011), else null.
//   GET ?name=<file>    -> { name, text, approvals: { [blog id]: { hash, approval, post } } } (any signed-in user)
//   POST { text, replace } -> { name, replaced, unapproved } (admins). The week is read from the blogs' dates (one
//                          week, Monday to Saturday, not over yet) and names the file. The file must pass checkUpload
//                          (core/weeklyBlogs.js), else 400 { error, problems }. Replacing a file takes back the approvals of blogs it changes or drops
//                          (`unapproved`: their ids).
//   DELETE { name, id, hash } -> { name, removed } (admins): takes one blog out of the file, and its approval, so it is
//                          never posted. `hash` is the version the admin looked at (409 if the file changed since). Not
//                          for a blog posted or being posted. The week's last blog takes the file with it. A failed attempt or a
//                          Dev.to draft of it is forgotten too, so it no longer shows in the Blog Tracker.
import { getCaller, requireAdmin, fail, handle } from '@/core/server/supabaseAdmin';
import { approvalOf, blogsWithHash, isLocked, planRemoval, postOf, staleApprovals } from '@/core/server/blogApproval';
import { BUCKET, NAME, SAVE, approvalRows, deleteApprovals, deleteUnfinishedPosts, postRows, readFile, readFileCached, storage } from '@/core/server/blogStore';
import { checkUpload } from '@/core/weeklyBlogs';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 5 * 1024 * 1024;
const SCHEDULE_WEEKS = 12; // newest files read for the schedule; older ones are listed only

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
      Promise.all(recent.map((f) => readFileCached(bucket, f.name, f.updatedAt))),
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
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) return fail('The file is empty.', 400);
  if (new TextEncoder().encode(text).length > MAX_BYTES) return fail('The file is larger than 5 MB.', 413);
  // The same check the page runs before showing the preview: a file sent past the page must pass it too.
  const check = checkUpload(text);
  if (check.error) return fail(check.error, 400);
  const name = check.fileName; // the week its dates are in
  if (check.errors.length || !name) {
    const [first = { id: '', message: 'No blog has a real publish_date, so the week is unknown.' }] = check.errors;
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
  const { error: err } = await bucket.upload(name, new Blob([text], { type: 'application/json' }), { ...SAVE, upsert: exists });
  if (err) return fail(`Could not save ${name}: ${err.message}`, 500);
  return Response.json({ name, replaced: exists, unapproved }, { status: exists ? 200 : 201 });
});

export const DELETE = handle(async (request) => {
  const { error } = await requireAdmin(request);
  if (error) return error;
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name : '';
  const id = typeof body.id === 'string' ? body.id : '';
  if (!NAME.test(name)) return fail('Unknown file.', 404);
  const bucket = await storage();
  // Without blog_posts (migration 011) nothing can have been posted; any other failure: don't guess (null).
  const [file, posts] = await Promise.all([
    readFile(bucket, name),
    postRows([name]).catch((err) => (/does not exist|schema cache/i.test(err.message) ? [] : (console.error('[api]', err.message), null))),
  ]);
  if (file.missing) return fail('File not found.', 404);
  if (file.problem) return fail(`Couldn't read ${name}: ${file.problem}`, 422);
  if (!posts) return fail('Could not check what was posted, so it was not removed. Try again.', 503);
  const plan = planRemoval({
    json: JSON.parse(file.text), blogs: file.blogs, id, hash: body.hash,
    locked: new Set(posts.filter(isLocked).map((r) => r.blog_id)),
  });
  if (plan.problem) return fail(plan.problem, plan.status);
  // The approval goes first: the backend posts from blog_approval, so once it is gone the blog can't be posted, even
  // if saving the file then fails.
  try {
    await deleteApprovals(name, [id]);
  } catch (err) {
    console.error('[api]', err.message);
    return fail(`Could not take back its approval, so it was not removed (is migration 010 applied?).`, 503);
  }
  // Another admin may have changed the file meanwhile (removed another blog, replaced it): saving this copy would undo
  // that. Read it again right before saving; if it changed, stop (the approval is already gone: the blog just waits).
  const now = await readFile(bucket, name);
  if (now.text !== file.text) {
    return fail(`${name} was changed by someone else just now, so ${id} was not removed. Look again and retry.`, 409);
  }
  // The week's last blog: the file goes. Otherwise the file is saved without it.
  let err;
  if (plan.json.blogs.length) {
    const text = `${JSON.stringify(plan.json, null, 2)}\n`;
    ({ error: err } = await bucket.upload(name, new Blob([text], { type: 'application/json' }), { ...SAVE, upsert: true }));
  } else {
    ({ error: err } = await bucket.remove([name]));
  }
  if (err) return fail(`Its approval was taken back, but ${name} could not be saved: ${err.message}`, 500);
  if (posts.some((r) => r.blog_id === id)) {
    // Removed from the file either way; at worst a stale row stays in the Blog Tracker.
    await deleteUnfinishedPosts(name, id).catch((e) => console.error('[api]', e.message));
  }
  return Response.json({ name, removed: id, fileDeleted: !plan.json.blogs.length });
});
