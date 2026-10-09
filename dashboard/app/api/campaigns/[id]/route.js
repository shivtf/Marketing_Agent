// One campaign (table public.campaign), admins only.
//   PATCH { any of campaignName, campaignDetail, startDate, endDate, isActive } -> the updated campaign
//   DELETE -> { ok: true } (the row is deleted)
import { adminClient, requireAdmin, fail, handle } from '@/core/server/supabaseAdmin';
import { TABLE, checkCampaign, toCampaign, dbError } from '@/core/server/campaigns';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PATCH = handle(async (request, { params }) => {
  const { error } = await requireAdmin(request);
  if (error) return error;
  const { id } = await params;
  if (!UUID.test(id)) return fail('Campaign not found.', 404);
  const { row, error: invalid } = checkCampaign(await request.json().catch(() => ({})), { partial: true });
  if (invalid) return invalid;
  if (!Object.keys(row).length) return fail('Nothing to change.', 400);
  const { data, error: err } = await adminClient().from(TABLE)
    .update({ ...row, updated_at: new Date().toISOString() }).eq('id', id).select('*').maybeSingle();
  if (err) return dbError(err, 'save the campaign');
  if (!data) return fail('Campaign not found.', 404);
  return Response.json(toCampaign(data));
});

export const DELETE = handle(async (request, { params }) => {
  const { error } = await requireAdmin(request);
  if (error) return error;
  const { id } = await params;
  if (!UUID.test(id)) return fail('Campaign not found.', 404);
  const { data, error: err } = await adminClient().from(TABLE).delete().eq('id', id).select('id');
  if (err) return dbError(err, 'delete the campaign');
  if (!data.length) return fail('Campaign not found.', 404);
  return Response.json({ ok: true });
});
