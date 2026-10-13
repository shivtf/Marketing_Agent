import { adminClient, requireAdmin, fail, summarize, handle } from '@/core/server/supabaseAdmin';

export const dynamic = 'force-dynamic';

export const GET = handle(async (request) => {
  const { error } = await requireAdmin(request);
  if (error) return error;
  const { data, error: err } = await adminClient().auth.admin.listUsers({ perPage: 200 });
  if (err) return fail('Could not load users.', 500);
  // Removed users are included (removed: true): the page lists them apart, with Restore.
  return Response.json(data.users.map(summarize));
});

export const POST = handle(async (request) => {
  const { error } = await requireAdmin(request);
  if (error) return error;
  const body = await request.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  if (!name) return fail('Enter the employee name.', 400);
  if (!/^\S+@\S+\.\S+$/.test(email)) return fail('Enter a valid email address.', 400);
  // The admin chooses the password and shares it; the employee can change it later from their profile.
  const password = String(body.password || '');
  if (password.length < 8) return fail('Password must be at least 8 characters.', 400);

  const { data, error: err } = await adminClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name },
    app_metadata: { role: 'employee' }, // without a role the account has no access (getCaller, backend auth.py)
  });
  if (err) {
    if (!/already|registered|exists/i.test(err.message)) return fail('Could not create the user.', 500);
    // The email may belong to a removed account: say so, so the page can offer to restore it instead.
    const { data: list } = await adminClient().auth.admin.listUsers({ perPage: 200 });
    const old = list?.users.find((u) => u.email?.toLowerCase() === email);
    if (old?.app_metadata?.removed) {
      return Response.json({ error: `${email} belongs to a removed account.`, removedId: old.id }, { status: 409 });
    }
    return fail('That email already has an account.', 409);
  }
  return Response.json(summarize(data.user), { status: 201 });
});
