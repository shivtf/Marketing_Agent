// The dashboard's Gmail connection (core/server/gmail.js). Read only: the dashboard never sends, deletes or changes mail.
//   GET    -> { configured, connected, email, connectedAt, connectedBy } (any signed-in user)
//   DELETE -> { ok: true }: Google's access is revoked and the saved token deleted (admins)
import { getCaller, requireAdmin, handle } from '@/core/server/supabaseAdmin';
import { disconnect, gmailError, status } from '@/core/server/gmail';

export const dynamic = 'force-dynamic';

export const GET = handle(async (request) => {
  const { error } = await getCaller(request);
  if (error) return error;
  try {
    return Response.json(await status());
  } catch (err) {
    return gmailError(err);
  }
});

export const DELETE = handle(async (request) => {
  const { error } = await requireAdmin(request);
  if (error) return error;
  try {
    await disconnect();
    return Response.json({ ok: true });
  } catch (err) {
    return gmailError(err);
  }
});
