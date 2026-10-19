// Tests for the Gmail inbox helpers. Run: node --test core/server/gmail.test.mjs (from dashboard/). No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decrypt, encrypt, signState, verifyState, STATE_MS } from './gmailTokens.js';
import { bodyText, detail, gmailQuery, htmlToText, onlyFrom, parseAddress, summary } from './gmailMessage.js';

const SECRET = 'test-secret-not-real';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');

// ---------- Token at rest ----------

test('a sealed token opens with the same secret only', () => {
  const sealed = encrypt('1//refresh-token', SECRET);
  assert.match(sealed, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.ok(!sealed.includes('refresh-token'));
  assert.equal(decrypt(sealed, SECRET), '1//refresh-token');
  assert.throws(() => decrypt(sealed, 'another-secret'));
});

test('a changed sealed token is refused', () => {
  const [v, iv, tag, data] = encrypt('1//refresh-token', SECRET).split('.');
  const flipped = Buffer.from(data, 'base64url');
  flipped[0] ^= 1;
  assert.throws(() => decrypt([v, iv, tag, flipped.toString('base64url')].join('.'), SECRET));
  assert.throws(() => decrypt('not-a-token', SECRET));
});

test('each seal is different (random IV)', () => {
  assert.notEqual(encrypt('same', SECRET), encrypt('same', SECRET));
});

// ---------- OAuth state ----------

test('state round trip gives back the admin who started', () => {
  const { state, nonce } = signState('admin-1', SECRET);
  assert.deepEqual(verifyState(state, nonce, SECRET), { uid: 'admin-1' });
});

test('state is refused from another browser, after 10 minutes, forged or signed with another secret', () => {
  const now = Date.now();
  const { state, nonce } = signState('admin-1', SECRET, now);
  assert.equal(verifyState(state, 'other-browser-nonce', SECRET, now), null);
  assert.equal(verifyState(state, undefined, SECRET, now), null);
  assert.equal(verifyState(state, nonce, SECRET, now + STATE_MS + 1), null);
  assert.equal(verifyState(state, nonce, 'another-secret', now), null);
  const [, sig] = state.split('.');
  const forged = `${b64(JSON.stringify({ uid: 'attacker', nonce, exp: now + STATE_MS }))}.${sig}`;
  assert.equal(verifyState(forged, nonce, SECRET, now), null);
  assert.equal(verifyState('', nonce, SECRET, now), null);
  assert.equal(verifyState('garbage', nonce, SECRET, now), null);
});

// ---------- Messages ----------

test('addresses', () => {
  assert.deepEqual(parseAddress('"Priya Shah" <Priya@Acme.co>'), { name: 'Priya Shah', email: 'priya@acme.co' });
  assert.deepEqual(parseAddress('ben@x.test'), { name: '', email: 'ben@x.test' });
  assert.deepEqual(parseAddress(''), { name: '', email: '' });
});

test('mail HTML becomes text: no script, style, tags or comments; entities decoded', () => {
  const html = '<html><head><style>p{color:red}</style></head><body><script>alert(1)</script>'
    + '<p>Hi Alex,</p><p>Yes &amp; <b>thanks</b> &#39;ok&#39;<br>Line 2</p><!-- tracker --><img src="https://t.example/p.gif">'
    + '<ul><li>One</li><li>Two</li></ul></body></html>';
  const text = htmlToText(html);
  assert.ok(!/alert|color:red|tracker|<|>/.test(text), text);
  assert.match(text, /Hi Alex,/);
  assert.match(text, /Yes & thanks 'ok'\nLine 2/);
  assert.match(text, /- One/);
  // An encoded tag stays text: React shows it as text, it is never parsed as HTML.
  assert.equal(htmlToText('&lt;script&gt;x&lt;/script&gt;'), '<script>x</script>');
});

const msg = (payload, extra = {}) => ({
  id: 'm1', threadId: 't1', internalDate: '1760000000000', labelIds: ['INBOX', 'UNREAD'], snippet: 'It&#39;s fine', payload, ...extra,
});
const headers = [{ name: 'From', value: 'Priya <priya@acme.co>' }, { name: 'Subject', value: 'Re: Hello' }, { name: 'To', value: 'us@x.test' }];

test('the text/plain part is preferred; HTML is used only when there is no text part', () => {
  const both = msg({
    mimeType: 'multipart/alternative', headers,
    parts: [{ mimeType: 'text/plain', body: { data: b64('Plain\r\nreply') } }, { mimeType: 'text/html', body: { data: b64('<p>Html</p>') } }],
  });
  assert.equal(bodyText(both), 'Plain\nreply');
  const htmlOnly = msg({ mimeType: 'text/html', headers, body: { data: b64('<p>Only <i>html</i></p>') } });
  assert.equal(bodyText(htmlOnly), 'Only html');
});

test('attachments are listed, never read as the body', () => {
  const m = msg({
    mimeType: 'multipart/mixed', headers,
    parts: [
      { mimeType: 'text/plain', filename: 'notes.txt', body: { attachmentId: 'a1', size: 10 } },
      { mimeType: 'text/plain', body: { data: b64('The reply') } },
    ],
  });
  const d = detail(m);
  assert.equal(d.body, 'The reply');
  assert.deepEqual(d.attachments, [{ name: 'notes.txt', size: 10 }]);
  assert.equal(d.to, 'us@x.test');
});

test('a list row', () => {
  const row = summary(msg({ mimeType: 'text/plain', headers, body: { data: b64('x') } }));
  assert.deepEqual(row, {
    id: 'm1', threadId: 't1', from: { name: 'Priya', email: 'priya@acme.co' }, subject: 'Re: Hello',
    snippet: "It's fine", date: new Date(1760000000000).toISOString(), unread: true,
  });
});

// ---------- Gmail search ----------

test('the Gmail search for each view', () => {
  assert.equal(gmailQuery({}), 'in:inbox');
  assert.equal(gmailQuery({ q: '  subject:demo ' }), 'in:inbox subject:demo');
  assert.equal(gmailQuery({ from: ['a@x.test', 'b@y.test'] }), 'from:(a@x.test OR b@y.test)');
  assert.equal(gmailQuery({ from: ['a@x.test'], q: 'pricing' }), 'from:(a@x.test) pricing');
  // Nobody emailed yet, or only unsafe addresses: nothing to search.
  assert.equal(gmailQuery({ from: [] }), null);
  assert.equal(gmailQuery({ from: ['a b@x.test', 'x)@y.test'] }), null);
  assert.equal(gmailQuery({ q: 'x'.repeat(500) }).length, 'in:inbox '.length + 200);
});

test('employees only get mail from lead addresses, whatever the search', () => {
  const items = [{ from: { email: 'priya@acme.co' } }, { from: { email: 'hr@ourcompany.co' } }, { from: { email: '' } }];
  assert.deepEqual(onlyFrom(items, ['Priya@Acme.co']), [{ from: { email: 'priya@acme.co' } }]);
  assert.deepEqual(onlyFrom(items, []), []);
});

test('quoted mail (<blockquote>) becomes "> " lines, as in a plain-text reply', () => {
  const html = '<div>No thanks.</div><blockquote>Interested in a call?<br><blockquote>older</blockquote></blockquote><p>after</p>';
  assert.equal(htmlToText(html), 'No thanks.\n\n> Interested in a call?\n\n> > older\n\nafter');
});
