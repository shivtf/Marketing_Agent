// Emails in the connected Gmail inbox, for the History page (read only). Any signed-in user.
//   GET ?view=inbox|leads&q=<Gmail search>&pageToken=<from the last page>
//     -> { items: [{ id, threadId, from: { name, email }, subject, snippet, date, unread, lead }], nextPageToken, estimate }
//   view=leads: mail from the people the agent emailed. lead: { id, name, company } when the sender is a lead.
import { getCaller, fail, handle } from '@/core/server/supabaseAdmin';
import { emailedAddresses, gmail, gmailError, GmailError, leadsByEmail } from '@/core/server/gmail';
import { gmailQuery, summary } from '@/core/server/gmailMessage';

export const dynamic = 'force-dynamic';

const PAGE = 25;
const TOKEN = /^[\w-]{1,200}$/;
const META = new URLSearchParams([['format', 'metadata'], ...['From', 'Subject'].map((h) => ['metadataHeaders', h])]);

export const GET = handle(async (request) => {
  const { error } = await getCaller(request);
  if (error) return error;
  const p = new URL(request.url).searchParams;
  const view = p.get('view') === 'leads' ? 'leads' : 'inbox';
  const pageToken = p.get('pageToken') || '';
  if (pageToken && !TOKEN.test(pageToken)) return fail('Unknown page.', 400);
  try {
    const q = gmailQuery({ q: p.get('q') || '', from: view === 'leads' ? await emailedAddresses() : null });
    if (q === null) return Response.json({ items: [], nextPageToken: null, estimate: 0 }); // nobody emailed yet
    const list = await gmail(`/messages?${new URLSearchParams({ q, maxResults: String(PAGE), ...(pageToken && { pageToken }) })}`);
    // The list has ids only: read each one's headers (in parallel). One deleted in the meantime is left out.
    const msgs = await Promise.all((list.messages || []).map((m) => gmail(`/messages/${m.id}?${META}`)
      .catch((err) => { if (err instanceof GmailError && err.status === 404) return null; throw err; })));
    const items = msgs.filter(Boolean).map(summary);
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
