// Server-only helpers for the Campaign Agent routes (app/api/ca, app/api/campaigns/[id]/requests).
import 'server-only';
import { adminClient } from './supabaseAdmin';
import { gateway } from './caGateway';

// Who asked, as a name: the gateway reports the email. The status is polled every few seconds, so the dashboard's users
// (a small team, like the Users page lists them) are looked up at most every 5 minutes. Falls back to the email.
const NAMES_MS = 5 * 60_000;
let names = { at: 0, byEmail: new Map() };
export async function nameOf(email) {
  if (!email) return null;
  if (Date.now() - names.at > NAMES_MS) {
    const { data, error } = await adminClient().auth.admin.listUsers({ perPage: 200 });
    if (!error) {
      names = { at: Date.now(), byEmail: new Map(data.users.map((u) => [u.email?.toLowerCase(), u.user_metadata?.name?.trim()])) };
    }
  }
  return names.byEmail.get(String(email).toLowerCase()) || email;
}

const iso = (t) => (t ? new Date(t).toISOString() : null);

// GET /v1/ca -> what the Agent Control card shows:
// { desiredState: 'running' | 'paused', actualState, inSync, requestedBy, requestedByName, requestedAt, stateSince,
//   agentStatus: 'idle' | 'busy' | 'paused', lastSeen, online }
export async function caStatus() {
  const ca = await gateway('/v1/ca');
  const c = ca.control || {};
  const desiredState = c.desired_state || 'running'; // nobody asked for anything yet: it runs
  const actualState = c.actual_state || desiredState;
  const ago = Number(ca.last_seen_s_ago);
  return {
    desiredState,
    actualState,
    inSync: desiredState === actualState,
    requestedBy: c.requested_by || null,
    requestedByName: await nameOf(c.requested_by),
    requestedAt: iso(c.requested_at),
    stateSince: iso(c.state_since),
    agentStatus: ca.status || null,
    lastSeen: Number.isFinite(ago) ? new Date(Date.now() - ago * 1000).toISOString() : null,
    online: !!ca.online,
  };
}

// The approval record: who sent a request, from the verified login only (at most 100 characters).
export const requestedBy = (user) => (user.email || user.id).slice(0, 100);
