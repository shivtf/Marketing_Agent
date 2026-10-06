// Admin-only user management. The server re-checks the admin role on every call.
import { authFetch } from './auth';

// GET /api/admin/users -> [{ id, email, name, role, createdAt, lastSignInAt }]
export const listUsers = () => authFetch('/api/admin/users');

// POST /api/admin/users  { name, email, password } -> the new user, signing in with the password the admin chose
export const createUser = (name, email, password) => authFetch('/api/admin/users', {
  method: 'POST',
  body: JSON.stringify({ name, email, password }),
});

// PATCH /api/admin/users/:id  { password } -> sets a new password chosen by the admin
export const setUserPassword = (id, password) => authFetch(`/api/admin/users/${id}`, {
  method: 'PATCH',
  body: JSON.stringify({ password }),
});

// DELETE /api/admin/users/:id -> hides the account from the dashboard and blocks sign-in (kept in Supabase)
export const removeUser = (id) => authFetch(`/api/admin/users/${id}`, { method: 'DELETE' });
