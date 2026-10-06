import { adminClient, anonClient, getCaller, fail, handle } from '@/core/server/supabaseAdmin';

// Self-service password change from the profile page. Done server-side so the current password is verified first.
export const POST = handle(async (request) => {
  const { user, error } = await getCaller(request);
  if (error) return error;
  const body = await request.json().catch(() => ({}));
  const current = String(body.current || '');
  const next = String(body.next || '');
  if (next.length < 8) return fail('New password must be at least 8 characters.', 400);
  if (next === current) return fail('New password must be different from the current one.', 400);

  const { error: authErr } = await anonClient().auth.signInWithPassword({ email: user.email, password: current });
  if (authErr) return fail('Current password is incorrect.', 400);

  const { error: err } = await adminClient().auth.admin.updateUserById(user.id, { password: next });
  if (err) return fail('Could not update the password.', 500);
  return Response.json({ ok: true });
});
