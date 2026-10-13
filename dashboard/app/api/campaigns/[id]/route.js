// One campaign (table public.campaign), admins only.
//   PATCH { updatedAt, any of campaignName, campaignDetail, startDate, endDate, isActive } -> the updated campaign.
//         updatedAt is the campaign's updatedAt as the page last saw it: if someone changed the campaign since, nothing
//         is saved (409) instead of silently overwriting their change.
//   DELETE -> { ok: true } (soft delete: the row stays in Supabase with deleted_at set, and is hidden from the page)
import { adminClient, requireAdmin, fail, handle } from '@/core/server/supabaseAdmin';
import { TABLE, checkCampaign, toCampaign, dbError } from '@/core/server/campaigns';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A timestamptz as Supabase sends it, e.g. 2026-10-12T09:30:00.123456+00:00
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

export const PATCH = handle(async (request, { params }) => {
  const { error } = await requireAdmin(request);
  if (error) return error;
  const { id } = await params;
  if (!UUID.test(id)) return fail('Campaign not found.', 404);
  const body = await request.json().catch(() => ({}));
  const seen = typeof body.updatedAt === 'string' && TIMESTAMP.test(body.updatedAt) ? body.updatedAt : null;
  if (!seen) return fail('This page is out of date. Reload it and try again.', 400);
  const { row, error: invalid } = checkCampaign(body, { partial: true });
  if (invalid) return invalid;
  if (!Object.keys(row).length) return fail('Nothing to change.', 400);
  const db = adminClient();
  // Saved only while updated_at is still what the page saw. Passed on as the exact text Supabase sent: a JS Date would
  // drop the microseconds of a now() default and never match.
  const { data, error: err } = await db.from(TABLE)
    .update({ ...row, updated_at: new Date().toISOString() })
    .eq('id', id).is('deleted_at', null).eq('updated_at', seen)
    .select('*').maybeSingle();
  if (err) return dbError(err, 'save the campaign');
  if (data) return Response.json(toCampaign(data));
  // Nothing saved: either the campaign is gone, or someone changed it since the page loaded it.
  const { data: now, error: findErr } = await db.from(TABLE).select('id').eq('id', id).is('deleted_at', null).maybeSingle();
  if (findErr) return dbError(findErr, 'save the campaign');
  if (!now) return fail('Campaign not found. Someone may have deleted it.', 404);
  return fail('Someone else changed this campaign while you had it open. Your change was not saved; the page now shows their version.', 409);
});

export const DELETE = handle(async (request, { params }) => {
  const { error } = await requireAdmin(request);
  if (error) return error;
  const { id } = await params;
  if (!UUID.test(id)) return fail('Campaign not found.', 404);
  const { data, error: err } = await adminClient().from(TABLE)
    .update({ deleted_at: new Date().toISOString() }).eq('id', id).is('deleted_at', null).select('id');
  if (err) return dbError(err, 'delete the campaign');
  if (!data.length) return fail('Campaign not found.', 404);
  return Response.json({ ok: true });
});
