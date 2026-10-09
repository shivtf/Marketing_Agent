// Server-only helpers for the campaign routes (app/api/campaigns): checking what the browser sent, and turning rows
// into what the page uses. Table: public.campaign (dashboardbackend/migrations/003_campaign.sql).
import 'server-only';
import { fail } from './supabaseAdmin';

export const TABLE = 'campaign';

const isDay = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; // 2026-02-30 rolls over: not a real day
};

// Body from the page -> { row } ready to save, or { error: Response }. `partial` (an update) checks only the fields
// that were sent; dates are then checked against each other only when both are sent (the database checks the rest).
export function checkCampaign(body, { partial = false } = {}) {
  const row = {};
  const has = (k) => k in body;
  if (!partial || has('campaignName')) {
    const name = String(body.campaignName ?? '').trim();
    if (!name) return { error: fail('Enter the campaign name.', 400) };
    if (name.length > 200) return { error: fail('The campaign name can be at most 200 characters.', 400) };
    row.campaign_name = name;
  }
  if (!partial || has('campaignDetail')) {
    const detail = String(body.campaignDetail ?? '').trim();
    if (detail.length > 5000) return { error: fail('The details can be at most 5000 characters.', 400) };
    row.campaign_detail = detail || null;
  }
  for (const [key, col, label] of [['startDate', 'start_date', 'start date'], ['endDate', 'end_date', 'end date']]) {
    if (!partial || has(key)) {
      if (!isDay(body[key])) return { error: fail(`Pick a ${label}.`, 400) };
      row[col] = body[key];
    }
  }
  if (row.start_date && row.end_date && row.end_date < row.start_date) {
    return { error: fail('The end date must be on or after the start date.', 400) };
  }
  if (!partial || has('isActive')) {
    if (has('isActive') && typeof body.isActive !== 'boolean') return { error: fail('isActive must be true or false.', 400) };
    row.is_active = body.isActive ?? true;
  }
  return { row };
}

export const toCampaign = (r) => ({
  id: r.id,
  campaignName: r.campaign_name,
  campaignDetail: r.campaign_detail || '',
  startDate: r.start_date,
  endDate: r.end_date,
  isActive: r.is_active,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// A Supabase error -> a clear Response. The usual first-time problem is the table not existing yet.
export function dbError(err, doing) {
  if (/campaign/.test(err?.message || '') && /(does not exist|could not find|schema cache)/i.test(err.message)) {
    return fail('The campaign table does not exist yet. Run dashboardbackend/migrations/003_campaign.sql in the Supabase SQL editor.', 500);
  }
  if (err?.code === '23514') return fail('The end date must be on or after the start date.', 400);
  console.error('[campaigns]', doing, err?.message);
  return fail(`Could not ${doing}.`, 500);
}
