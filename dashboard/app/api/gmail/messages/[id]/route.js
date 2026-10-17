// One email from the connected Gmail inbox, as plain text (read only). Admins can open any email; employees only email
// from the people the agent emailed (the same ones the "From leads" list shows them).
//   GET -> { id, threadId, from, to, cc, subject, date, unread, body, attachments: [{ name, size }], lead }
//   Mail HTML is turned into text on the server and never sent to the page; attachments are listed, not downloaded.
import { getCaller, fail, handle } from '@/core/server/supabaseAdmin';
import { emailedAddresses, gmail, gmailError, leadsByEmail } from '@/core/server/gmail';
import { detail } from '@/core/server/gmailMessage';

export const dynamic = 'force-dynamic';

const ID = /^[A-Za-z0-9_-]{6,64}$/;

export const GET = handle(async (request, { params }) => {
  const { user, error } = await getCaller(request);
  if (error) return error;
  const { id } = await params;
  if (!ID.test(id)) return fail('This email is no longer in Gmail.', 404);
  try {
    const msg = detail(await gmail(`/messages/${id}?format=full`));
    // Same answer as a missing email, so an employee can't tell other mail exists.
    if (user.app_metadata?.role !== 'admin' && !(await emailedAddresses()).includes(msg.from.email)) {
      return fail('This email is no longer in Gmail.', 404);
    }
    const leads = await leadsByEmail([msg.from.email]);
    return Response.json({ ...msg, lead: leads[msg.from.email] ?? null });
  } catch (err) {
    return gmailError(err);
  }
});
