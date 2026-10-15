// The Campaign Agent's status, through its gateway (GET /v1/ca). Any signed-in user.
//   GET -> { desiredState, actualState, inSync, requestedBy, requestedByName, requestedAt, stateSince, agentStatus,
//            lastSeen, online } (core/server/ca.js caStatus)
import { getCaller, handle } from '@/core/server/supabaseAdmin';
import { gatewayError } from '@/core/server/caGateway';
import { caStatus } from '@/core/server/ca';

export const dynamic = 'force-dynamic';

export const GET = handle(async (request) => {
  const { error } = await getCaller(request);
  if (error) return error;
  try {
    return Response.json(await caStatus());
  } catch (err) {
    return gatewayError(err, 'show its status');
  }
});
