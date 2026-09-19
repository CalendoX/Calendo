import { NextResponse, type NextRequest } from 'next/server';
import { getAuth } from '@/server/auth/session';
import { appUrl } from '@/server/config/env';
import { isAppError } from '@/server/http/errors';
import { beginOAuth } from '@/server/integrations/connections';
import { isProviderSlug, providerFromSlug } from '@/server/integrations/registry';

function redirect(url: string) {
  const res = NextResponse.redirect(url, 303);
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

/**
 * Shareable "connect" link (GET /integrations/connect/google|zoom): starts OAuth for whoever is
 * signed in to Calendor in *this* browser and sends them to the provider. It works from any
 * browser — people sign in to Calendor there first — while the OAuth state stays bound to that
 * browser's session, so a forwarded link can never attach someone else's account to yours.
 */
export async function GET(req: NextRequest, context: { params: Promise<{ provider: string }> }) {
  // Client-side navigations (e.g. after signing in) fetch this as RSC; an empty non-RSC response
  // makes the router fall back to a full page load, which then follows the OAuth redirect.
  if (req.headers.get('rsc')) return new Response(null, { status: 204 });
  const { provider } = await context.params;
  if (!isProviderSlug(provider)) return redirect(appUrl('/integrations?error=unknown_provider'));
  const auth = await getAuth();
  if (!auth) return redirect(appUrl(`/login?next=${encodeURIComponent(`/integrations/connect/${provider}`)}`));
  try {
    return redirect(await beginOAuth(auth, providerFromSlug(provider)));
  } catch (err) {
    const url = new URL(appUrl('/integrations'));
    url.searchParams.set('error', 'connect_failed');
    url.searchParams.set('provider', provider);
    url.searchParams.set('message', isAppError(err) ? err.message.slice(0, 200) : 'Could not start the connection. Please try again.');
    return redirect(url.toString());
  }
}
