// Server-only Supabase helpers for the API routes. The service role key must never reach the browser.
import 'server-only';
import { createClient } from '@supabase/supabase-js';

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const json = (error, status) => Response.json({ error }, { status });

export const adminClient = () => {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set on the server.');
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, key, opts);
};

export const anonClient = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);

// Resolves the caller from the Bearer token. Returns { user } or { error: Response }.
export async function getCaller(request) {
  const token = /^Bearer (.+)$/i.exec(request.headers.get('authorization') || '')?.[1];
  if (!token) return { error: json('Not signed in.', 401) };
  const { data, error } = await adminClient().auth.getUser(token);
  if (error || !data.user || data.user.app_metadata?.removed) return { error: json('Not signed in.', 401) };
  // Only accounts an admin gave a dashboard role, whatever the project's sign-up setting is (same rule as the
  // backend's current_user).
  if (!ROLES.includes(data.user.app_metadata?.role)) return { error: json('This account has no access to the dashboard.', 403) };
  // The person's own token, for the Campaign Agent's gateway (X-User-Token): it proves who asked. Not enumerable, so it
  // never ends up in a response by accident.
  Object.defineProperty(data.user, 'accessToken', { value: token, enumerable: false });
  return { user: data.user };
}

export async function requireAdmin(request) {
  const caller = await getCaller(request);
  if (caller.error) return caller;
  if (caller.user.app_metadata?.role !== 'admin') return { error: json('Admins only.', 403) };
  return caller;
}

export const fail = json;

export const ROLES = ['admin', 'employee'];

export const summarize = (u) => ({
  id: u.id,
  email: u.email,
  name: u.user_metadata?.name || '',
  role: ROLES.includes(u.app_metadata?.role) ? u.app_metadata.role : 'none', // 'none': can't use the dashboard
  createdAt: u.created_at,
  lastSignInAt: u.last_sign_in_at,
  removed: !!u.app_metadata?.removed, // removed from the dashboard (banned), kept in Supabase; can be restored
});

// Wraps a handler so a missing env var or unexpected failure becomes a clean JSON 500.
export const handle = (fn) => async (request, ctx) => {
  try {
    return await fn(request, ctx);
  } catch (err) {
    console.error('[api]', err.message);
    return json(err.message.includes('SERVICE_ROLE') ? err.message : 'Something went wrong.', 500);
  }
};
