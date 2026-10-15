// Server-only client for the Campaign Agent's gateway (docs/dashboard-integration (1).md, section 2.1).
// The Campaign Agent runs on a private office machine; its gateway on Render is the only way in. The token stays on the
// server (CA_GATEWAY_TOKEN, never in browser code), and the browser only ever calls this dashboard's own routes.
import 'server-only';
import { fail } from './supabaseAdmin';

const DEFAULT_URL = 'https://campaign-agent-maha.onrender.com';
// The gateway is on Render's free plan: after ~15 minutes without a call it sleeps and wakes in 30 to 60 s.
const TIMEOUT_MS = 90_000;

export class GatewayError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// -> the gateway's JSON. Throws GatewayError: status 0 = not reachable or timed out, otherwise the gateway's own status.
export async function gateway(path, { method = 'GET', body, timeout = TIMEOUT_MS } = {}) {
  const token = (process.env.CA_GATEWAY_TOKEN || '').trim();
  if (!token) throw new GatewayError(503, 'CA_GATEWAY_TOKEN is not set on the dashboard server.');
  const base = (process.env.CA_GATEWAY_URL || DEFAULT_URL).trim().replace(/\/$/, '');
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new GatewayError(0, "The assistant's gateway did not answer. Try again in a minute.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = typeof data?.detail === 'string' ? data.detail : typeof data?.error === 'string' ? data.error : '';
    throw new GatewayError(res.status, detail || `The assistant's gateway answered ${res.status}.`);
  }
  return data;
}

// A GatewayError -> a Response for the browser. The gateway's wording is passed on for the user's own mistakes (a bad
// or stale request); the token problems are explained for whoever runs the dashboard.
export function gatewayError(err, doing) {
  if (!(err instanceof GatewayError)) throw err;
  console.error('[ca-gateway]', doing, err.status, err.message);
  if (err.status === 0) return fail(err.message, 502);
  if (err.status === 401 || err.status === 403) return fail("The assistant's gateway refused the dashboard's token (check CA_GATEWAY_TOKEN).", 502);
  if (err.status === 404) return fail('The assistant does not know this campaign yet.', 404);
  if (err.status === 503 && /CA_GATEWAY_TOKEN/.test(err.message)) return fail(err.message, 503);
  if (err.status >= 500) return fail(`The assistant could not ${doing} right now. Try again in a minute.`, 503);
  return fail(err.message, err.status); // 409, 422, 429: what was wrong with the request
}
