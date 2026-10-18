// Pause / resume the Campaign Agent, through its gateway (POST /v1/ca/state; docs/dashboard-pause-resume.md).
// Pausing it also stops the Marketing Agent; resuming starts that again only if it was running when the pause came.
//   POST { state: 'paused' | 'running' } -> the status, as GET /api/ca.
//   Pause: anyone signed in (the safety brake). Resume: admins only, since it can start the Marketing Agent again.
import { getCaller, fail, handle } from '@/core/server/supabaseAdmin';
import { gateway, gatewayError } from '@/core/server/caGateway';
import { caStatus, requestedBy } from '@/core/server/ca';

export const dynamic = 'force-dynamic';

export const POST = handle(async (request) => {
  const { user, error } = await getCaller(request);
  if (error) return error;
  const { state } = await request.json().catch(() => ({}));
  if (!['paused', 'running'].includes(state)) return fail("state must be 'paused' or 'running'.", 400);
  if (state === 'running' && user.app_metadata?.role !== 'admin') return fail('Only admins can resume the agent.', 403);
  const doing = state === 'paused' ? 'pause' : 'resume';
  try {
    await gateway('/v1/ca/state', { method: 'POST', user, body: { state, requested_by: requestedBy(user) } });
    return Response.json(await caStatus());
  } catch (err) {
    return gatewayError(err, doing);
  }
});
