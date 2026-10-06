import { adminClient, requireAdmin, fail, summarize, handle } from '@/core/server/supabaseAdmin';

export const dynamic = 'force-dynamic';

export const GET = handle(async (request) => {
  const { error } = await requireAdmin(request);
  if (error) return error;
  const { data, error: err } = await adminClient().auth.admin.listUsers({ perPage: 200 });
  if (err) return fail('Could not load users.', 500);
  // Users removed from the dashboard stay in Supabase but are hidden here.
  return Response.json(data.users.filter((u) => !u.app_metadata?.removed).map(summarize));
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
  });
  if (err) {
    const taken = /already|registered|exists/i.test(err.message);
    return taken ? fail('That email already has an account.', 409) : fail('Could not create the user.', 500);
  }
  return Response.json(summarize(data.user), { status: 201 });
});
