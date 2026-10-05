// All authentication lives here, backed by Supabase Auth. Nothing else in the app should know how auth works.
import { supabase } from './supabase';

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export const isAuthenticated = async () => !!(await getSession());

// Roles and the first-login flag live in app_metadata, which only the server can write.
export const isAdmin = (session) => session?.user?.app_metadata?.role === 'admin';
export const mustChangePassword = (session) => !!session?.user?.app_metadata?.must_change_password;

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error('Invalid email or password.');
  return data.session;
}

export async function signOut() {
  await supabase.auth.signOut();
}

// Authenticated call to this app's own /api routes; throws Error with the server's message.
export async function authFetch(path, options = {}) {
  const session = await getSession();
  let res;
  try {
    res = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers, ...(session && { Authorization: `Bearer ${session.access_token}` }) },
    });
  } catch {
    throw new Error('Cannot reach the server.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || 'Something went wrong. Please try again.'), { status: res.status });
  return body;
}

// Verifies the current password server-side, then refreshes the session so the first-login flag clears.
export async function changePassword(current, next) {
  await authFetch('/api/account/password', { method: 'POST', body: JSON.stringify({ current, next }) });
  await supabase.auth.refreshSession();
}
