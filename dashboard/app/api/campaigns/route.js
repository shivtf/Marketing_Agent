// Campaigns (table public.campaign).
//   GET  -> [{ id, campaignName, campaignDetail, startDate, endDate, isActive, createdAt, updatedAt }] newest start
//           date first (any signed-in user)
//   POST { campaignName, campaignDetail, startDate, endDate, isActive } -> the new campaign (admins)
import { adminClient, getCaller, requireAdmin, handle } from '@/core/server/supabaseAdmin';
import { TABLE, checkCampaign, toCampaign, dbError } from '@/core/server/campaigns';

export const dynamic = 'force-dynamic';

export const GET = handle(async (request) => {
  const { error } = await getCaller(request);
  if (error) return error;
  const { data, error: err } = await adminClient().from(TABLE).select('*')
    .order('start_date', { ascending: false }).order('created_at', { ascending: false });
  if (err) return dbError(err, 'load the campaigns');
  return Response.json(data.map(toCampaign));
});

export const POST = handle(async (request) => {
  const { error } = await requireAdmin(request);
  if (error) return error;
  const { row, error: invalid } = checkCampaign(await request.json().catch(() => ({})));
  if (invalid) return invalid;
  const { data, error: err } = await adminClient().from(TABLE).insert(row).select('*').single();
  if (err) return dbError(err, 'create the campaign');
  return Response.json(toCampaign(data), { status: 201 });
});
