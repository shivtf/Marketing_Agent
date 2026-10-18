// Send a request about one campaign to the Campaign Agent, through its gateway (POST /v1/campaigns/{id}/requests;
// docs/dashboard-integration (1).md, sections 2.3 and 3.4). Admins only, like every other change to a campaign.
//   POST { request_type, payload, base_revision, idempotency_key } -> 202 and the gateway's answer (the request row).
// The request is recorded at once and the agent works on it (a model call takes minutes): the page then polls
// GET /api/campaigns/{id} until last_request is done or failed. requested_by is the approval record, so it comes from
// the verified login here, never from the page.
import { requireAdmin, fail, handle } from '@/core/server/supabaseAdmin';
import { gateway, gatewayError } from '@/core/server/caGateway';
import { requestedBy } from '@/core/server/ca';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = new Set(['interpret', 'answer', 'edit', 'suggestion', 'approve', 'discard', 'rollback', 'deactivate']);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const POST = handle(async (request, { params }) => {
  const { user, error } = await requireAdmin(request);
  if (error) return error;
  const { id } = await params;
  if (!UUID.test(id)) return fail('Campaign not found.', 404);
  const body = await request.json().catch(() => ({}));
  const payload = body.payload ?? {};
  const base = body.base_revision ?? null;
  const key = body.idempotency_key;
  if (!TYPES.has(body.request_type)) return fail('Unknown request type.', 422);
  if (!isObject(payload)) return fail('The payload must be an object.', 422);
  if (base !== null && !Number.isInteger(base)) return fail('base_revision must be a whole number.', 422);
  if (body.request_type === 'edit' && base === null) return fail('A change needs the revision you were looking at. Reload and try again.', 422);
  if (typeof key !== 'string' || !key.trim() || key.length > 200) return fail('Missing idempotency_key.', 422);
  try {
    const sent = await gateway(`/v1/campaigns/${id}/requests`, {
      method: 'POST',
      user,
      body: { request_type: body.request_type, payload, base_revision: base, idempotency_key: key, requested_by: requestedBy(user) },
    });
    return Response.json(sent, { status: 202 });
  } catch (err) {
    return gatewayError(err, 'take the request');
  }
});
