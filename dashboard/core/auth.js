// All authentication lives here, backed by Supabase Auth. Nothing else in the app should know how auth works.
import { supabase } from './supabase';

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export const isAuthenticated = async () => !!(await getSession());

// Roles live in app_metadata, which only the server can write.
export const isAdmin = (session) => session?.user?.app_metadata?.role === 'admin';

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error('Invalid email or password.');
  // One sign-in per account: end its sessions on other devices. Their tokens stop working at the backend's next
  // check (it looks the session up), and those browsers return to the login page.
  await supabase.auth.signOut({ scope: 'others' }).catch(() => {});
  return data.session;
}

export async function signOut() {
  await supabase.auth.signOut();
}

// The backend rejected this browser's token: forget the session here only (the account may be signed in elsewhere)
// and go to the login page, saying why when another sign-in ended this one.
export const ELSEWHERE = 'Signed in on another device';
export async function endSession(reason) {
  await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
  window.location.assign(reason === ELSEWHERE ? '/login?ended=elsewhere' : '/login');
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

// Verifies the current password server-side, then sets the new one.
export async function changePassword(current, next) {
  await authFetch('/api/account/password', { method: 'POST', body: JSON.stringify({ current, next }) });
}
