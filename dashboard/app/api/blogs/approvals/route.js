// Approving blogs before they are posted (admins). The publishing backend posts a blog only when it is approved, and
// posts the copy taken here (table blog_approval; the contract is at the top of
// dashboardbackend/migrations/010_blog_approval.sql).
//   POST { name, decisions: [{ id, status: 'approved' | 'rejected' | 'waiting', reason?, hash }] }
//     -> { approvals: { [blog id]: approval } } for the file. `hash` is the version the admin looked at (from GET
//     /api/blogs/weekly-files). All or nothing: 409 when the file was replaced since (look again), 400 { error, problems }
//     for anything else that can't be decided. A blog posted (or being posted) by the backend can't be decided again.
import { requireAdmin, fail, handle } from '@/core/server/supabaseAdmin';
import { approvalOf, isLocked, planDecisions } from '@/core/server/blogApproval';
import { NAME, approvalRows, postRows, readFile, saveDecisions, storage } from '@/core/server/blogStore';

export const dynamic = 'force-dynamic';

export const POST = handle(async (request) => {
  const { user, error } = await requireAdmin(request);
  if (error) return error;
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name : '';
  if (!NAME.test(name)) return fail('Unknown file.', 404);

  const file = await readFile(await storage(), name);
  if (file.missing) return fail('File not found.', 404);
  if (file.problem) return fail(`Couldn't read ${name}: ${file.problem}`, 422);
  // Before migration 011 nothing can have been posted, so no blog is locked.
  const posts = await postRows([name]).catch((err) => { console.error('[api]', err.message); return []; });
  const plan = planDecisions({
    fileName: name,
    blogs: file.blogs,
    decisions: body.decisions,
    by: user.email,
    today: new Date().toISOString().slice(0, 10),
    locked: new Set(posts.filter(isLocked).map((r) => r.blog_id)),
  });
  if (plan.problems.length) {
    const [first] = plan.problems;
    const more = plan.problems.length > 1 ? ` (and ${plan.problems.length - 1} more)` : '';
    return Response.json({ error: `${first.id ? `${first.id}: ` : ''}${first.message}${more}`, problems: plan.problems },
      { status: plan.changed ? 409 : 400 });
  }
  await saveDecisions(name, plan.upserts, plan.clear);

  const rows = new Map((await approvalRows([name])).map((r) => [r.blog_id, r]));
  const approvals = {};
  for (const b of file.blogs) if (b.id) approvals[b.id] = approvalOf(b.hash, rows.get(b.id));
  return Response.json({ approvals });
});
