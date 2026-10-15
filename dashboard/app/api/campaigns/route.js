// Campaigns (table public.campaign).
//   GET  -> [{ id, campaignName, campaignDetail, startDate, endDate, isActive, createdAt, updatedAt }] newest start
//           date first, deleted ones left out (any signed-in user)
//   POST { campaignName, campaignDetail, startDate, endDate, isActive } -> the new campaign (admins). Then the Campaign
//        Agent is asked to start on it ('interpret'), after the answer is sent: that call can wait up to a minute for its
//        gateway to wake, and a failure never undoes the save (the agent also finds new campaigns by itself in ~30 s).
import { after } from 'next/server';
import { adminClient, getCaller, requireAdmin, handle } from '@/core/server/supabaseAdmin';
import { TABLE, checkCampaign, toCampaign, dbError } from '@/core/server/campaigns';
import { gateway } from '@/core/server/caGateway';
import { requestedBy } from '@/core/server/ca';

export const dynamic = 'force-dynamic';

export const GET = handle(async (request) => {
  const { error } = await getCaller(request);
  if (error) return error;
  const { data, error: err } = await adminClient().from(TABLE).select('*').is('deleted_at', null)
    .order('start_date', { ascending: false }).order('created_at', { ascending: false });
  if (err) return dbError(err, 'load the campaigns');
  return Response.json(data.map(toCampaign));
});

export const POST = handle(async (request) => {
  const { user, error } = await requireAdmin(request);
  if (error) return error;
  const { row, error: invalid } = checkCampaign(await request.json().catch(() => ({})));
  if (invalid) return invalid;
  const { data, error: err } = await adminClient().from(TABLE).insert(row).select('*').single();
  if (err) return dbError(err, 'create the campaign');
  after(async () => {
    try {
      await gateway(`/v1/campaigns/${data.id}/requests`, {
        method: 'POST',
        body: { request_type: 'interpret', payload: {}, requested_by: requestedBy(user), idempotency_key: `interpret-${data.id}` },
      });
    } catch (e) {
      console.error('[campaigns] could not ask the assistant to start; it will find the campaign by itself:', e.message);
    }
  });
  return Response.json(toCampaign(data), { status: 201 });
});
