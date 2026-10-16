// Google sends the browser back here after its consent screen: GET ?code&state, or ?error. A browser redirect carries
// no dashboard login, so the signed `state` (made by POST /api/gmail/connect, admins only) and the cookie set with it
// prove an admin in this browser started it in the last 10 minutes; the admin role is checked again now.
// -> /history?gmail=<result>. Only a short result code goes in the address, never a message the page would show.
import { NextResponse } from 'next/server';
import { adminClient } from '@/core/server/supabaseAdmin';
import { config, connect, GmailError, OAUTH_COOKIE, OAUTH_COOKIE_PATH } from '@/core/server/gmail';
import { verifyState } from '@/core/server/gmailTokens';

export const dynamic = 'force-dynamic';

function back(request, result) {
  const to = new URL('/history', request.url);
  to.searchParams.set('gmail', result);
  const res = NextResponse.redirect(to);
  res.cookies.set(OAUTH_COOKIE, '', { path: OAUTH_COOKIE_PATH, maxAge: 0 });
  return res;
}

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const c = config();
  if (!c) return back(request, 'notconfigured');
  if (params.get('error')) return back(request, params.get('error') === 'access_denied' ? 'denied' : 'refused');
  const started = verifyState(params.get('state'), request.cookies.get(OAUTH_COOKIE)?.value, c.secret);
  if (!started) return back(request, 'expired');
  try {
    const { data } = await adminClient().auth.admin.getUserById(started.uid);
    const admin = data?.user;
    if (!admin || admin.app_metadata?.role !== 'admin' || admin.app_metadata?.removed) return back(request, 'notadmin');
    await connect(request, params.get('code') || '', admin.email || admin.id);
    return back(request, 'connected');
  } catch (err) {
    if (err instanceof GmailError) return back(request, err.code === 'no_table' ? 'notable' : err.code || 'failed');
    console.error('[gmail] callback', err.message);
    return back(request, 'failed');
  }
}
