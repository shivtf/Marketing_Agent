// All data access lives here. Leads, emails and blogs come from the backend (eval/dashboardbackend/app/data.py);
// pipelines are still mock data. Nothing else in the app touches data.js.
import { pipelines } from './data.js';
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
  if (!res.ok) throw new ApiError(`Request failed (${res.status})`, res.status);
  return res.json();
}

// GET /auth/me -> { id, email, role }; 401 when the token is invalid or expired
export const getMe = () => apiFetch('/auth/me');

const wait = (ms = 350) => new Promise((r) => setTimeout(r, ms));
const clone = (x) => JSON.parse(JSON.stringify(x));
const qs = (params) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
  return q ? `?${q}` : '';
};

// ---------- Pipelines (mock: no backend table yet) ----------

export async function getPipelines() {
  await wait();
  return clone(pipelines);
}

export async function startPipeline(id) {
  await wait(200);
  pipelines.find((p) => p.id === id).status = 'running';
  return clone(pipelines);
}

export async function pausePipeline(id) {
  await wait(200);
  pipelines.find((p) => p.id === id).status = 'paused';
  return clone(pipelines);
}

// ---------- Leads ----------

export const getLeads = ({ status, source } = {}) => apiFetch(`/leads${qs({ status, source })}`);
export const getLeadStats = () => apiFetch('/leads/stats');
export const getLead = (id) => apiFetch(`/leads/${encodeURIComponent(id)}`);
export const getPositiveLeads = () => apiFetch('/leads/positive');

// ---------- Emails ----------

export const getSentEmails = () => apiFetch('/emails/sent');
export const getSentEmail = (id) => apiFetch(`/emails/sent/${encodeURIComponent(id)}`);
export const getReplies = () => apiFetch('/emails/replies');
export const getReply = (id) => apiFetch(`/emails/replies/${encodeURIComponent(id)}`);

// ---------- Blogs ----------

export const getBlogs = () => apiFetch('/blogs');
export const getBlog = (id) => apiFetch(`/blogs/${encodeURIComponent(id)}`);
