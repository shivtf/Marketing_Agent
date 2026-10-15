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

// The "Active" slider turned off: if this campaign is the live one, the Campaign Agent is asked to switch it off, which also
// stops the Marketing Agent. Turned off on a campaign that is not live changes nothing there (it must not stop the work of
// the campaign that is). Turning it on again does not start anything: that needs an approval. Best effort, after the answer.
export async function switchOffCampaign(id, user) {
  try {
    const view = await gateway(`/v1/campaigns/${id}`);
    if (!(view.state === 'PUBLISHED' || view.review_view?.live)) return;
    await gateway(`/v1/campaigns/${id}/requests`, {
      method: 'POST',
      body: { request_type: 'deactivate', payload: {}, requested_by: requestedBy(user), idempotency_key: `deactivate-slider-${id}-${Date.now()}` },
    });
  } catch (e) {
    console.error('[campaigns] could not tell the assistant the campaign was switched off:', e.message);
  }
}

// A campaign the dashboard deletes must stop running. The delete only marks the row, so the Campaign Agent is told:
// a live campaign is switched off ('deactivate', so the Marketing Agent stops being given it), and one that is still
// being worked on is closed ('discard'). Best effort and after the answer is sent: the delete never waits for it or fails
// because of it. A campaign the agent has never seen (state NEW) or has already closed needs nothing.
export async function closeCampaign(id, user) {
  try {
    const view = await gateway(`/v1/campaigns/${id}`);
    const steps = [];
    if (view.state === 'PUBLISHED' || view.review_view?.live) steps.push('deactivate');
    if (!['NEW', 'DISCARDED', 'PUBLISHED'].includes(view.state)) steps.push('discard');
    for (const type of steps) {
      await gateway(`/v1/campaigns/${id}/requests`, {
        method: 'POST',
        body: { request_type: type, payload: {}, requested_by: requestedBy(user), idempotency_key: `${type}-deleted-${id}` },
      });
    }
  } catch (e) {
    console.error('[campaigns] could not tell the assistant the campaign was deleted:', e.message);
  }
}
