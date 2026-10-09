// Weekly blog files: the JSON for one week (Monday to Saturday), stored as is in Supabase Storage, bucket
// "blog-plans", named by its week, e.g. 12_10_26-17_10_26.json. Nothing here reads the blogs inside; another
// backend picks the file up from the bucket.
//   GET                 -> [{ name, size, updatedAt }] newest week first (any signed-in user)
//   GET ?name=<file>    -> { name, text } the file itself (any signed-in user)
//   POST { week, text, replace } -> { name, replaced } (admins; week = that week's Monday, "YYYY-MM-DD")
import { adminClient, getCaller, requireAdmin, fail, handle } from '@/core/server/supabaseAdmin';

export const dynamic = 'force-dynamic';

const BUCKET = 'blog-plans';
const MAX_BYTES = 5 * 1024 * 1024;
const NAME = /^\d{2}_\d{2}_\d{2}-\d{2}_\d{2}_\d{2}\.json$/;

const ddmmyy = (d) => [d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCFullYear() % 100].map((n) => String(n).padStart(2, '0')).join('_');

// "2026-10-12" (a Monday) -> "12_10_26-17_10_26.json"; null when it isn't a real Monday.
function fileName(week) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week || '')) return null;
  const monday = new Date(`${week}T00:00:00Z`);
  if (Number.isNaN(monday.getTime()) || monday.toISOString().slice(0, 10) !== week || monday.getUTCDay() !== 1) return null;
  const saturday = new Date(monday.getTime() + 5 * 86400000);
  return `${ddmmyy(monday)}-${ddmmyy(saturday)}.json`;
}

// Sorts by the Monday in the name (DD_MM_YY), newest first.
const weekKey = (name) => { const [d, m, y] = name.slice(0, 8).split('_'); return `${y}${m}${d}`; };

// The bucket is created on first use (private: only the server's service key can read or write it).
async function storage() {
  const client = adminClient();
  const { error } = await client.storage.getBucket(BUCKET);
  if (error) {
    const { error: createError } = await client.storage.createBucket(BUCKET, { public: false });
    if (createError && !/already exists/i.test(createError.message)) throw new Error(`Could not create the ${BUCKET} bucket: ${createError.message}`);
  }
  return client.storage.from(BUCKET);
}

async function listFiles(bucket) {
  const { data, error } = await bucket.list('', { limit: 1000 });
  if (error) throw new Error(`Could not list ${BUCKET}: ${error.message}`);
  return data
    .filter((f) => NAME.test(f.name))
    .map((f) => ({ name: f.name, size: f.metadata?.size ?? null, updatedAt: f.updated_at || f.created_at }))
    .sort((a, b) => weekKey(b.name).localeCompare(weekKey(a.name)));
}

export const GET = handle(async (request) => {
  const { error } = await getCaller(request);
  if (error) return error;
  const bucket = await storage();
  const name = new URL(request.url).searchParams.get('name');
  if (name === null) return Response.json(await listFiles(bucket));
  if (!NAME.test(name)) return fail('Unknown file.', 404);
  const { data, error: err } = await bucket.download(name);
  if (err) return fail('File not found.', 404);
  return Response.json({ name, text: await data.text() });
});

export const POST = handle(async (request) => {
  const { error } = await requireAdmin(request);
  if (error) return error;
  const body = await request.json().catch(() => ({}));
  const name = fileName(body.week);
  if (!name) return fail('Pick the week (its Monday).', 400);
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) return fail('The file is empty.', 400);
  if (new TextEncoder().encode(text).length > MAX_BYTES) return fail('The file is larger than 5 MB.', 413);
  try {
    JSON.parse(text);
  } catch {
    return fail('The file is not valid JSON.', 400);
  }

  const bucket = await storage();
  const exists = (await listFiles(bucket)).some((f) => f.name === name);
  if (exists && body.replace !== true) return Response.json({ error: `${name} already exists.`, exists: true, name }, { status: 409 });
  const { error: err } = await bucket.upload(name, new Blob([text], { type: 'application/json' }), {
    contentType: 'application/json',
    upsert: exists,
  });
  if (err) return fail(`Could not save ${name}: ${err.message}`, 500);
  return Response.json({ name, replaced: exists }, { status: exists ? 200 : 201 });
});
