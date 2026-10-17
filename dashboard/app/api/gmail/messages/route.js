// Emails in the connected Gmail inbox, for the History page (read only).
//   GET ?view=inbox|leads&q=<Gmail search>&pageToken=<from the last page>
//     -> { items: [{ id, threadId, from: { name, email }, subject, snippet, date, unread, lead }], nextPageToken, estimate }
//   view=leads: mail from the people the agent emailed. lead: { id, name, company } when the sender is a lead.
//   view=inbox (the whole mailbox) is for admins only: employees always get view=leads, whatever they ask for, and
//   every result is checked against the lead addresses (the search text can't widen it).
import { getCaller, fail, handle } from '@/core/server/supabaseAdmin';
import { emailedAddresses, gmail, gmailError, GmailError, leadsByEmail } from '@/core/server/gmail';
import { gmailQuery, onlyFrom, summary } from '@/core/server/gmailMessage';

export const dynamic = 'force-dynamic';

const PAGE = 25;
const TOKEN = /^[\w-]{1,200}$/;
const META = new URLSearchParams([['format', 'metadata'], ...['From', 'Subject'].map((h) => ['metadataHeaders', h])]);

export const GET = handle(async (request) => {
  const { user, error } = await getCaller(request);
  if (error) return error;
  const p = new URL(request.url).searchParams;
  const admin = user.app_metadata?.role === 'admin';
  const view = p.get('view') === 'leads' || !admin ? 'leads' : 'inbox';
  const pageToken = p.get('pageToken') || '';
  if (pageToken && !TOKEN.test(pageToken)) return fail('Unknown page.', 400);
  try {
    const from = view === 'leads' ? await emailedAddresses() : null;
    const q = gmailQuery({ q: p.get('q') || '', from });
    if (q === null) return Response.json({ items: [], nextPageToken: null, estimate: 0 }); // nobody emailed yet
    const list = await gmail(`/messages?${new URLSearchParams({ q, maxResults: String(PAGE), ...(pageToken && { pageToken }) })}`);
    // The list has ids only: read each one's headers (in parallel). One deleted in the meantime is left out.
    const msgs = await Promise.all((list.messages || []).map((m) => gmail(`/messages/${m.id}?${META}`)
      .catch((err) => { if (err instanceof GmailError && err.status === 404) return null; throw err; })));
    const all = msgs.filter(Boolean).map(summary);
    const items = from ? onlyFrom(all, from) : all;
    const leads = await leadsByEmail(items.map((m) => m.from.email));
    return Response.json({
      items: items.map((m) => ({ ...m, lead: leads[m.from.email] ?? null })),
      nextPageToken: list.nextPageToken ?? null,
      estimate: list.resultSizeEstimate ?? 0,
    });
  } catch (err) {
    return gmailError(err);
  }
});
