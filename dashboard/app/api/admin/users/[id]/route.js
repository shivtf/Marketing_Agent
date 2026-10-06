import { adminClient, requireAdmin, fail, summarize, handle } from '@/core/server/supabaseAdmin';

// Set a new password for an employee (chosen by the admin). The employee can change it later from their profile.
export const PATCH = handle(async (request, { params }) => {
  const { user, error } = await requireAdmin(request);
  if (error) return error;
  const { id } = await params;
  if (id === user.id) return fail('Change your own password from your profile.', 400);
  const body = await request.json().catch(() => ({}));
  const password = String(body.password || '');
  if (password.length < 8) return fail('Password must be at least 8 characters.', 400);

  const admin = adminClient();
  const { data: target, error: findErr } = await admin.auth.admin.getUserById(id);
  if (findErr || !target.user) return fail('User not found.', 404);

  const { data, error: err } = await admin.auth.admin.updateUserById(id, { password });
  if (err) return fail('Could not reset the password.', 500);
  return Response.json(summarize(data.user));
});

// Remove an employee from the dashboard. The account stays in Supabase (nothing is deleted from the database):
// it is marked removed (hidden from the list) and banned so it can no longer sign in.
// Admins can't remove themselves, so at least one admin always remains.
export const DELETE = handle(async (request, { params }) => {
  const { user, error } = await requireAdmin(request);
  if (error) return error;
  const { id } = await params;
  if (id === user.id) return fail("You can't remove your own account.", 400);

  const admin = adminClient();
  const { data: target, error: findErr } = await admin.auth.admin.getUserById(id);
  if (findErr || !target.user) return fail('User not found.', 404);

  const { error: err } = await admin.auth.admin.updateUserById(id, {
    ban_duration: '876000h', // ~100 years: blocks sign-in and token refresh
    app_metadata: { ...target.user.app_metadata, removed: true },
  });
  if (err) return fail('Could not remove the user.', 500);
  return Response.json({ ok: true });
});
