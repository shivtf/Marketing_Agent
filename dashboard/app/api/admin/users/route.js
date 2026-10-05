import { DEFAULT_PASSWORD } from '@/core/server/defaults';
import { adminClient, requireAdmin, fail, summarize, handle } from '@/core/server/supabaseAdmin';

export const dynamic = 'force-dynamic';

export const GET = handle(async (request) => {
  const { error } = await requireAdmin(request);
  if (error) return error;
  const { data, error: err } = await adminClient().auth.admin.listUsers({ perPage: 200 });
  if (err) return fail('Could not load users.', 500);
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

  // must_change_password lives in app_metadata: users can edit user_metadata themselves, but not this.
  const { data, error: err } = await adminClient().auth.admin.createUser({
    email,
    password: DEFAULT_PASSWORD,
    email_confirm: true,
    user_metadata: { name },
    app_metadata: { must_change_password: true },
  });
  if (err) return fail(/already|registered|exists/i.test(err.message) ? 'That email already has an account.' : 'Could not create the user.', /already|registered|exists/i.test(err.message) ? 409 : 500);
  return Response.json(summarize(data.user), { status: 201 });
});
