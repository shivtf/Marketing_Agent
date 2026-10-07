// All data access lives here. Everything comes from the backend (dashboardbackend/app).
import { getSession } from './auth';

// ---------- Backend (eval/dashboardbackend) ----------
const API_URL = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; } // status 0 = backend unreachable
}

// Calls the Python backend with the Supabase access token as a Bearer token.
export async function apiFetch(path, options = {}) {
  const session = await getSession();
  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: { ...options.headers, ...(session && { Authorization: `Bearer ${session.access_token}` }) },
    });
  } catch {
    throw new ApiError('Cannot reach the server.', 0);
  }
  if (!res.ok) {
    // FastAPI puts the reason in { detail } (e.g. a missing table); show it when it's plain text.
    const detail = await res.json().then((b) => b.detail).catch(() => null);
    throw new ApiError(typeof detail === 'string' ? detail : `Request failed (${res.status})`, res.status);
  }
  return res.json();
}

// GET /auth/me -> { id, email, role }; 401 when the token is invalid or expired
export const getMe = () => apiFetch('/auth/me');

const qs = (params) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
  return q ? `?${q}` : '';
};

// ---------- Agent (dashboardbackend/app/agent.py -> pipeline control API, see pipeline-api.md) ----------
// -> { desiredState, state: 'running' | 'stopped' | 'offline', online, inSync, requestedBy, currentPass, nextPassAt,
//      lastPass, sendingEnabled, testMode, ... }. Start/Stop are requests the office machine applies within seconds.

export const getAgent = () => apiFetch('/agent');
export const startAgent = () => apiFetch('/agent/start', { method: 'POST' });
export const stopAgent = () => apiFetch('/agent/stop', { method: 'POST' });

// ---------- Leads ----------

export const getLeads = ({ status, source } = {}) => apiFetch(`/leads${qs({ status, source })}`);
export const getLeadStats = () => apiFetch('/leads/stats');
export const getLead = (id) => apiFetch(`/leads/${encodeURIComponent(id)}`);
// -> { positive, review, questions, repliedLeads, pending }: leads judged on their latest human reply.
// An older backend returns a plain list; fail cleanly (the page shows "Couldn't load" + Retry) instead of crashing.
export async function getPositiveLeads() {
  const data = await apiFetch('/leads/positive');
  const ok = data && ['positive', 'review', 'questions'].every((k) => Array.isArray(data[k]));
  if (!ok) throw new ApiError('Unexpected response from /leads/positive. Is the backend up to date?', 200);
  return data;
}

// ---------- Emails ----------

export const getSentEmails = () => apiFetch('/emails/sent');
export const getSentEmail = (id) => apiFetch(`/emails/sent/${encodeURIComponent(id)}`);
export const getReplies = () => apiFetch('/emails/replies');
export const getReply = (id) => apiFetch(`/emails/replies/${encodeURIComponent(id)}`);

// ---------- Blogs ----------

export const getBlogs = () => apiFetch('/blogs');
export const getBlog = (id) => apiFetch(`/blogs/${encodeURIComponent(id)}`);
