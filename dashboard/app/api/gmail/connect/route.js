// Start connecting Gmail (admins). POST -> { url }: the page then sends the browser to Google's consent screen.
// The signed `state` and a short-lived httpOnly cookie let only this browser, for this admin, finish the connection
// within 10 minutes (app/api/gmail/callback).
import { NextResponse } from 'next/server';
import { requireAdmin, fail, handle } from '@/core/server/supabaseAdmin';
import { authUrl, config, OAUTH_COOKIE, OAUTH_COOKIE_PATH } from '@/core/server/gmail';
import { signState, STATE_MS } from '@/core/server/gmailTokens';

export const dynamic = 'force-dynamic';

export const POST = handle(async (request) => {
  const { user, error } = await requireAdmin(request);
  if (error) return error;
  const c = config();
  if (!c) return fail('Gmail is not set up: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the server settings.', 503);
  const { state, nonce } = signState(user.id, c.secret);
  const res = NextResponse.json({ url: authUrl(request, state) });
  res.cookies.set(OAUTH_COOKIE, nonce, {
    httpOnly: true,
    sameSite: 'lax', // sent when Google's page sends the browser back (a top-level GET)
    secure: process.env.NODE_ENV === 'production',
    path: OAUTH_COOKIE_PATH,
    maxAge: STATE_MS / 1000,
  });
  return res;
});
