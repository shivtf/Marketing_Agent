// All data access lives here. Everything comes from the backend (dashboardbackend/app).
import { authFetch, endSession, getSession, NO_ACCESS } from './auth';

// ---------- Backend (eval/dashboardbackend) ----------
const API_URL = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; } // status 0 = backend unreachable
}

// Calls the Python backend with the Supabase access token as a Bearer token. A 401 (signed out), 409 (the account
// is in use on another device) or 403 NO_ACCESS (the account has no dashboard role) ends the session and returns to
// the login page, unless `keepSession` is set.
export async function apiFetch(path, { keepSession, ...options } = {}) {
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
    const ended = res.status === 401 || res.status === 409 || (res.status === 403 && detail === NO_ACCESS);
    if (ended && session && !keepSession) await endSession(detail);
    throw new ApiError(typeof detail === 'string' ? detail : `Request failed (${res.status})`, res.status);
  }
  return res.json();
}

// Sign-out everywhere (dashboardbackend/app/accounts.py). Supabase keeps sessions alive when a password changes.
// An admin signs a user out on every device (after a password reset or a removal) -> { ended }
export const endUserSessions = (id) => apiFetch(`/admin/users/${encodeURIComponent(id)}/end-sessions`, { method: 'POST' });
// After changing your own password: signs you out on your other devices, keeping this one -> { ended }
export const endOtherSessions = () => apiFetch('/auth/end-other-sessions', { method: 'POST' });

// GET /auth/me -> { id, email, role }; 401 when the token is invalid or expired
export const getMe = (opts) => apiFetch('/auth/me', opts);
// Frees the account for another sign-in right away (otherwise it frees up a few minutes after the last check-in).
export const releaseAccount = () => apiFetch('/auth/signout', { method: 'POST', keepSession: true });

const qs = (params) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
  return q ? `?${q}` : '';
};

// ---------- Agent control (app/api/ca -> the Campaign Agent's gateway, docs/dashboard-pause-resume.md) ----------
// The Campaign Agent, which also starts and stops the Marketing Agent. The dashboard never controls the Marketing
// Agent itself (docs/dashboard-integration.md).
// -> { desiredState: 'running' | 'paused', actualState, inSync, requestedBy, requestedAt, stateSince,
//      agentStatus: 'idle' | 'busy' | 'paused', lastSeen, online }. Pause/resume is applied within seconds.
export const getAgent = () => authFetch('/api/ca');
export const pauseAgent = () => authFetch('/api/ca/state', { method: 'POST', body: JSON.stringify({ state: 'paused' }) });
export const resumeAgent = () => authFetch('/api/ca/state', { method: 'POST', body: JSON.stringify({ state: 'running' }) });

// List routes are paged: -> { items, total, page, limit } (blogs also carry `posted`). Filters run on the server.

// ---------- Leads ----------

export const getLeads = ({ status, source, page, limit } = {}) => apiFetch(`/leads${qs({ status, source, page, limit })}`);
export const getLeadStats = () => apiFetch('/leads/stats');
export const getLead = (id) => apiFetch(`/leads/${encodeURIComponent(id)}`);
// -> { positive, review, questions, notInterested, repliedLeads, pending }: leads judged on their latest human reply.
// notInterested defaults to empty so a backend deployed before that group still loads.
// An older backend returns a plain list; fail cleanly (the page shows "Couldn't load" + Retry) instead of crashing.
export async function getPositiveLeads() {
  const data = await apiFetch('/leads/positive');
  const ok = data && ['positive', 'review', 'questions'].every((k) => Array.isArray(data[k]));
  if (!ok) throw new ApiError('Unexpected response from /leads/positive. Is the backend up to date?', 200);
  return { notInterested: [], unsubscribe: [], ...data };
}

// Reads new replies from the connected Gmail inbox (read only; backend app/inbox.py)
// -> { checked, newReplies, processed, remaining, followUpsChecked }. 503 with a readable detail when Gmail is not set
// up or connected, or migration 007 has not been run.
export const checkInbox = () => apiFetch('/inbox/check', { method: 'POST' });
// A person's label for a reply (source: 'agent' | 'inbox'; label null removes it) -> { ok }. Shown instead of the agent's
// label; the mail agent does not see it.
export const labelReply = ({ source, replyId, label }) => apiFetch('/inbox/label', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, replyId, label }),
});

// ---------- Leads that need a contact (dashboardbackend/app/needs_contact.py) ----------

// Qualified companies the Marketing Agent found no email for -> { items: [{ id, company, website, score, about, formUrl,
// reason, since }], total, page, limit }, strongest first.
export const getNeedsContact = () => apiFetch('/needs-contact?limit=200');
// Saves the email a person found: { email, name?, role? } -> { ok }. The agent then writes the email and posts the
// approval request to Slack. Refusals (bad address, already handled) come back as an ApiError with a readable message.
export const addContact = (id, contact) => apiFetch(`/needs-contact/${encodeURIComponent(id)}/contact`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(contact),
});

// ---------- Emails ----------

// q: search text; status: 'sent' | 'failed'. -> { items, total, page, limit, failed } (failed: of all sent emails)
export const getSentEmails = ({ q, status, page, limit } = {}) => apiFetch(`/emails/sent${qs({ q, status, page, limit })}`);
export const getSentEmail = (id) => apiFetch(`/emails/sent/${encodeURIComponent(id)}`);
// One reply, for the drawer (opened from a sent email's "Open linked reply").
export const getReply = (id) => apiFetch(`/emails/replies/${encodeURIComponent(id)}`);

// ---------- Blogs ----------

export const getBlogs = ({ page, limit } = {}) => apiFetch(`/blogs${qs({ page, limit })}`);
export const getBlog = (id) => apiFetch(`/blogs/${encodeURIComponent(id)}`);
