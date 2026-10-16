// The Gmail refresh token at rest, and the OAuth `state` that ties Google's answer to the admin who clicked Connect
// Gmail. Both keys are derived from GOOGLE_CLIENT_SECRET, so there is no extra setting: a refresh token is of no use
// without that secret anyway, and a copy of the database alone can't read it. Changing the secret means connecting
// Gmail again. Relative imports only, so `node --test` can load it (core/server/gmail.test.mjs).
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

const key = (secret, purpose) => Buffer.from(hkdfSync('sha256', secret, 'marketing-dashboard-gmail', purpose, 32));
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sameBytes = (a, b) => a.length === b.length && timingSafeEqual(a, b);

// text -> "v1.<iv>.<tag>.<data>"
export function encrypt(text, secret) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(secret, 'token'), iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return ['v1', b64u(iv), b64u(c.getAuthTag()), b64u(data)].join('.');
}

// Throws when the value was changed or sealed with another secret.
export function decrypt(sealed, secret) {
  const [v, iv, tag, data] = String(sealed).split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unknown token format.');
  const d = createDecipheriv('aes-256-gcm', key(secret, 'token'), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

export const STATE_MS = 10 * 60_000; // the admin has 10 minutes on Google's screen
const mac = (body, secret) => createHmac('sha256', key(secret, 'state')).update(body).digest();

// -> { state, nonce }. The nonce also goes in an httpOnly cookie, so only the browser that started can finish.
export function signState(userId, secret, now = Date.now()) {
  const nonce = b64u(randomBytes(16));
  const body = b64u(JSON.stringify({ uid: userId, nonce, exp: now + STATE_MS }));
  return { state: `${body}.${b64u(mac(body, secret))}`, nonce };
}

// -> { uid } of the admin who started, or null: forged, expired, or finished in another browser.
export function verifyState(state, nonce, secret, now = Date.now()) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig || !nonce) return null;
  if (!sameBytes(Buffer.from(sig, 'base64url'), mac(body, secret))) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!(claims.exp > now) || !sameBytes(Buffer.from(String(claims.nonce)), Buffer.from(String(nonce)))) return null;
  return { uid: claims.uid };
}
