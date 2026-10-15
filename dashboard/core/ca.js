// The Campaign Agent's side of one campaign (app/api/campaigns/[id] and .../requests). Everyone signed in can see it;
// only admins send requests. The agent itself is never called from the browser.
import { authFetch } from './auth';

// -> { campaign, assistant: { campaign_id, state, revision, review_view, last_request } | null, assistantError }
export const getCampaignView = (id) => authFetch(`/api/campaigns/${id}`);

// { request_type, payload, base_revision, idempotency_key } -> the recorded request. The same key for the same campaign
// is the same request, so a retry or a double click never sends two.
export const sendRequest = (id, req) => authFetch(`/api/campaigns/${id}/requests`, { method: 'POST', body: JSON.stringify(req) });

// A short, stable fingerprint of a text, for idempotency keys ("edit-<revision>-<hash>").
export function shortHash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
