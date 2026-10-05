import { DEFAULT_PASSWORD } from '@/core/server/defaults';
import { adminClient, requireAdmin, fail, summarize, handle } from '@/core/server/supabaseAdmin';

// Reset an employee's password back to the default and force a change at next login.
export const PATCH = handle(async (request, { params }) => {
  const { user, error } = await requireAdmin(request);
  if (error) return error;
  const { id } = await params;
  if (id === user.id) return fail('Change your own password from your profile.', 400);

  const admin = adminClient();
  const { data: target, error: findErr } = await admin.auth.admin.getUserById(id);
  if (findErr || !target.user) return fail('User not found.', 404);

  const { data, error: err } = await admin.auth.admin.updateUserById(id, {
    password: DEFAULT_PASSWORD,
    app_metadata: { ...target.user.app_metadata, must_change_password: true },
  });
  if (err) return fail('Could not reset the password.', 500);
  return Response.json(summarize(data.user));
});
