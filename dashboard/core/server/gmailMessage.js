// Gmail API messages -> what the History page shows, and the Gmail search for each view. No imports, so `node --test`
// can load it (core/server/gmail.test.mjs).

const header = (msg, name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

// An address that is safe inside a Gmail search: no spaces, quotes, brackets or parentheses.
export const SAFE_ADDRESS = /^[^\s()"<>]+@[^\s()"<>]+$/;

// "Priya Shah <Priya@Acme.co>" -> { name: 'Priya Shah', email: 'priya@acme.co' }
export function parseAddress(value) {
  const v = String(value || '').trim();
  const m = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(v);
  if (m) return { name: m[1].replace(/^"|"$/g, '').trim(), email: m[2].toLowerCase() };
  const bare = /[^\s<>,;"]+@[^\s<>,;"]+/.exec(v);
  return { name: '', email: bare ? bare[0].toLowerCase() : '' };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const entity = (m, e) => {
  if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
  const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
};

// Quoted mail (<blockquote>, marked \x01 ... \x02 below) -> "> " lines, as in a plain-text reply.
function quoteLines(text) {
  let depth = 0;
  const out = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '\x01' || line.trim() === '\x02') {
      depth = line.trim() === '\x01' ? depth + 1 : Math.max(0, depth - 1);
      continue;
    }
    out.push(depth && line.trim() ? '> '.repeat(depth) + line : line);
  }
  return out.join('\n');
}

// Mail HTML -> plain text (same rules as the backend's gmail.py html_to_text). The page never renders mail HTML, so a
// message can't run scripts or load trackers there.
export function htmlToText(html) {
  const text = String(html || '')
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<blockquote\b[^>]*>/gi, '\n\x01\n')
    .replace(/<\/blockquote\s*>/gi, '\n\x02\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table)\s*>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, entity)
    .replace(/ /g, ' ');
  return quoteLines(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const decode = (data) => Buffer.from(String(data || ''), 'base64url').toString('utf8');
const parts = (p, out = []) => {
  if (p) {
    out.push(p);
    for (const c of p.parts || []) parts(c, out);
  }
  return out;
};

export const MAX_BODY = 100_000;

// The message text: its text/plain part, else its HTML as text. Attachments are never read.
export function bodyText(msg) {
  const all = parts(msg.payload).filter((p) => p.body?.data && !p.filename);
  const plain = all.find((p) => p.mimeType === 'text/plain');
  const html = all.find((p) => p.mimeType === 'text/html');
  const text = (plain ? decode(plain.body.data).replace(/\r\n?/g, '\n') : html ? htmlToText(decode(html.body.data)) : '').trim();
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}\n\n[… cut here: the message is longer]` : text;
}

export const attachments = (msg) => parts(msg.payload)
  .filter((p) => p.filename && p.body?.attachmentId)
  .map((p) => ({ name: p.filename, size: p.body.size ?? null }));

// One row of the list: { id, threadId, from: { name, email }, subject, snippet, date, unread }
export function summary(msg) {
  return {
    id: msg.id,
    threadId: msg.threadId,
    from: parseAddress(header(msg, 'From')),
    subject: header(msg, 'Subject'),
    snippet: htmlToText(msg.snippet), // Gmail sends it with HTML entities (&#39;)
    date: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null,
    unread: (msg.labelIds || []).includes('UNREAD'),
  };
}

// The whole message, as text.
export const detail = (msg) => ({
  ...summary(msg), to: header(msg, 'To'), cc: header(msg, 'Cc'), body: bodyText(msg), attachments: attachments(msg),
});

// Only the emails sent from one of `addresses`. Applied to every result an employee gets, after Gmail answered, so
// nothing typed in the search box (e.g. ") OR (in:inbox") can widen what they see.
export function onlyFrom(items, addresses) {
  const allowed = new Set(addresses.map((a) => a.toLowerCase()));
  return items.filter((m) => allowed.has(m.from.email));
}

// The Gmail search for a view: the inbox, or mail from the people the agent emailed (`from`: their addresses), found
// anywhere but spam and trash so archived replies count too. `q` is the user's own Gmail search, added as is: it can
// only narrow what this read-only access already sees. -> null when there is nothing to search (nobody emailed yet).
export function gmailQuery({ q = '', from = null }) {
  const own = String(q).trim().slice(0, 200);
  let base = 'in:inbox';
  if (from) {
    const safe = from.filter((a) => SAFE_ADDRESS.test(a));
    if (!safe.length) return null;
    base = `from:(${safe.join(' OR ')})`;
  }
  return own ? `${base} ${own}` : base;
}
