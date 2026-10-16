// Server-only Gmail access, read only (scope gmail.readonly): the dashboard never sends, deletes or changes mail.
// One inbox is connected for the whole dashboard by an admin (Connect Gmail on the History page). Its refresh token is
// kept encrypted in public.gmail_connection (dashboardbackend/migrations/006_gmail_connection.sql); the Google client
// comes from GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Nothing here reaches the browser.
import 'server-only';
import { adminClient } from './supabaseAdmin';
import { decrypt, encrypt } from './gmailTokens';
import { SAFE_ADDRESS } from './gmailMessage';

export const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const OAUTH_COOKIE = 'gmail_oauth';
export const OAUTH_COOKIE_PATH = '/api/gmail/callback';
const TABLE = 'gmail_connection';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TIMEOUT_MS = 20_000;

// status: the HTTP status for the browser; code: what the page does about it (e.g. 'reconnect' offers Connect again).
export class GmailError extends Error {
  constructor(status, message, code = null) { super(message); this.status = status; this.code = code; }
}

// A GmailError -> a Response for the browser; anything else is a bug and goes to handle()'s 500.
export function gmailError(err) {
  if (!(err instanceof GmailError)) throw err;
  return Response.json({ error: err.message, code: err.code }, { status: err.status });
}

// -> { id, secret }, or null when the two settings are missing.
export function config() {
  const id = (process.env.GOOGLE_CLIENT_ID || '').trim();
  const secret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  return id && secret ? { id, secret } : null;
}

function needConfig() {
  const c = config();
  if (!c) throw new GmailError(503, 'Gmail is not set up: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are missing on the server.', 'not_configured');
  return c;
}

// Where Google sends the browser back. It must be listed exactly under Authorized redirect URIs in Google Cloud;
// GMAIL_REDIRECT_URI overrides it when the site's own address is not what the browser sees (e.g. behind a proxy).
export const redirectUri = (request) => (process.env.GMAIL_REDIRECT_URI || '').trim()
  || `${new URL(request.url).origin}${OAUTH_COOKIE_PATH}`;

// Google's consent screen. prompt=consent so Google always sends a refresh token, even to a second connect.
export function authUrl(request, state) {
  const { id } = needConfig();
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({
    client_id: id, redirect_uri: redirectUri(request), response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', state,
  }).toString();
  return u.toString();
}

async function postForm(url, params) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new GmailError(502, 'Google did not answer. Try again in a minute.');
  }
  return { res, data: await res.json().catch(() => ({})) };
}

// ---------- The saved connection ----------

const NO_TABLE = (err) => ['42P01', 'PGRST205'].includes(err?.code)
  || /gmail_connection/.test(err?.message || '') && /does not exist|could not find/i.test(err?.message || '');

function dbError(err, doing) {
  if (NO_TABLE(err)) {
    return new GmailError(500, 'The gmail_connection table does not exist yet. Run dashboardbackend/migrations/006_gmail_connection.sql in the Supabase SQL editor.', 'no_table');
  }
  console.error('[gmail]', doing, err?.message);
  return new GmailError(500, `Could not ${doing}.`);
}

async function loadConnection() {
  const { data, error } = await adminClient().from(TABLE).select('*').eq('id', 1).maybeSingle();
  if (error) throw dbError(error, 'read the Gmail connection');
  return data;
}

// -> { configured, connected, email, connectedAt, connectedBy }
export async function status() {
  if (!config()) return { configured: false, connected: false, email: null, connectedAt: null, connectedBy: null };
  const row = await loadConnection();
  return { configured: true, connected: !!row, email: row?.email ?? null, connectedAt: row?.connected_at ?? null, connectedBy: row?.connected_by ?? null };
}

// The access token Google last gave out, kept in memory until a minute before it expires (they last an hour).
// `sealed` ties it to the saved connection, so a reconnect or disconnect elsewhere is noticed.
let cached = { token: null, until: 0, sealed: null };
const remember = (token, expiresIn, sealed) => {
  cached = { token, until: Date.now() + (Number(expiresIn) || 0) * 1000 - 60_000, sealed };
};

// Google's answer to the consent screen (?code=...) -> the connection is saved. -> { email }
export async function connect(request, code, by) {
  const { id, secret } = needConfig();
  const { res, data } = await postForm('https://oauth2.googleapis.com/token', {
    code, client_id: id, client_secret: secret, redirect_uri: redirectUri(request), grant_type: 'authorization_code',
  });
  if (!res.ok || !data.access_token) {
    console.error('[gmail] code exchange refused', res.status, data.error);
    throw new GmailError(400, `Google refused the sign-in (${data.error || res.status}).`, 'refused');
  }
  if (!String(data.scope || '').split(' ').includes(SCOPE)) {
    throw new GmailError(400, "Read access to Gmail was not allowed: tick the Gmail box on Google's screen.", 'noscope');
  }
  if (!data.refresh_token) throw new GmailError(400, 'Google sent no lasting access.', 'norefresh');
  const profile = await gmailFetch('/profile', data.access_token);
  const sealed = encrypt(data.refresh_token, secret);
  const { error } = await adminClient().from(TABLE).upsert({
    id: 1, email: profile.emailAddress, refresh_token: sealed, connected_by: by, connected_at: new Date().toISOString(),
  });
  if (error) throw dbError(error, 'save the Gmail connection');
  remember(data.access_token, data.expires_in, sealed);
  return { email: profile.emailAddress };
}

// Google's access is revoked (best effort) and the saved token deleted.
export async function disconnect() {
  const row = await loadConnection();
  cached = { token: null, until: 0, sealed: null };
  if (!row) return;
  try {
    await postForm('https://oauth2.googleapis.com/revoke', { token: decrypt(row.refresh_token, needConfig().secret) });
  } catch (err) {
    console.error('[gmail] revoke failed, removing the connection anyway:', err.message);
  }
  const { error } = await adminClient().from(TABLE).delete().eq('id', 1);
  if (error) throw dbError(error, 'remove the Gmail connection');
}

const RECONNECT = "Google ended the dashboard's Gmail access (the Google app is still in Testing and 7 days passed, the "
  + "account's password changed, or the access was removed). An admin can connect Gmail again.";

async function accessToken() {
  const { id, secret } = needConfig();
  const row = await loadConnection();
  if (!row) throw new GmailError(409, 'Gmail is not connected. An admin can connect it here.', 'not_connected');
  if (cached.token && cached.sealed === row.refresh_token && Date.now() < cached.until) return cached.token;
  let refreshToken;
  try {
    refreshToken = decrypt(row.refresh_token, secret);
  } catch {
    throw new GmailError(409, 'The saved Gmail access can no longer be read (the Google client secret changed). An admin can connect Gmail again.', 'reconnect');
  }
  const { res, data } = await postForm('https://oauth2.googleapis.com/token', {
    client_id: id, client_secret: secret, refresh_token: refreshToken, grant_type: 'refresh_token',
  });
  if (data.error === 'invalid_grant') throw new GmailError(409, RECONNECT, 'reconnect');
  if (!res.ok || !data.access_token) {
    console.error('[gmail] token refresh refused', res.status, data.error);
    throw new GmailError(502, `Google refused to renew the access (${data.error || res.status}). Try again in a minute.`);
  }
  remember(data.access_token, data.expires_in, row.refresh_token);
  return cached.token;
}

// ---------- Gmail API ----------

async function gmailFetch(path, token) {
  let res;
  try {
    res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new GmailError(502, 'Gmail did not answer. Try again in a minute.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  const why = data?.error?.message || '';
  if (res.status === 404) throw new GmailError(404, 'This email is no longer in Gmail.');
  if (res.status === 401) {
    cached = { token: null, until: 0, sealed: null };
    throw new GmailError(409, RECONNECT, 'reconnect');
  }
  if (res.status === 403 && /has not been used|is disabled/i.test(why)) {
    throw new GmailError(503, 'The Gmail API is not enabled in the Google Cloud project (APIs & Services → Library → Gmail API → Enable).', 'api_disabled');
  }
  if (res.status === 429 || /rate limit/i.test(why)) throw new GmailError(429, 'Gmail is limiting requests. Wait a minute and try again.');
  console.error('[gmail]', path.split('?')[0], res.status, why);
  throw new GmailError(502, `Gmail answered ${res.status}. Try again in a minute.`);
}

// GET a Gmail API path (under users/me) with the connected inbox's access.
export const gmail = async (path) => gmailFetch(path, await accessToken());

// ---------- Leads ----------

// The addresses the agent emailed, newest first, at most 100: "From leads" searches Gmail for mail from them.
export async function emailedAddresses() {
  const { data, error } = await adminClient().from('emails').select('sent_at, contacts(email)')
    .in('status', ['sent', 'bounced']).not('sent_at', 'is', null).order('sent_at', { ascending: false }).limit(500);
  if (error) throw dbError(error, 'read who the agent emailed');
  const out = [];
  for (const r of data) {
    const email = r.contacts?.email?.trim().toLowerCase();
    if (email && SAFE_ADDRESS.test(email) && !out.includes(email)) out.push(email);
    if (out.length >= 100) break;
  }
  return out;
}

// Sender addresses -> { [email]: { id, name, company } } for those that are leads. A failure only loses the lead links.
export async function leadsByEmail(addresses) {
  const list = [...new Set(addresses.filter(Boolean))];
  if (!list.length) return {};
  const { data, error } = await adminClient().from('contacts').select('id, name, email, companies(name)').in('email', list);
  if (error) {
    console.error('[gmail] lead lookup', error.message);
    return {};
  }
  return Object.fromEntries(data.map((c) => [c.email.toLowerCase(), { id: c.id, name: c.name, company: c.companies?.name ?? null }]));
}
