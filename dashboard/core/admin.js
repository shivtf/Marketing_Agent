// Admin-only user management. The server re-checks the admin role on every call.
import { authFetch } from './auth';

// GET /api/admin/users -> [{ id, email, name, role, mustChangePassword, createdAt, lastSignInAt }]
export const listUsers = () => authFetch('/api/admin/users');

// POST /api/admin/users  { name, email } -> the new user, created with the default password
export const createUser = (name, email) => authFetch('/api/admin/users', { method: 'POST', body: JSON.stringify({ name, email }) });

// PATCH /api/admin/users/:id -> resets the password to the default and forces a change at next login
export const resetUserPassword = (id) => authFetch(`/api/admin/users/${id}`, { method: 'PATCH' });
