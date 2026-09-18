import { NextResponse, type NextRequest } from 'next/server';
import { getAuth } from '@/server/auth/session';
import { appUrl } from '@/server/config/env';
import { isAppError } from '@/server/http/errors';
import { requestMeta } from '@/server/http/request';
import { completeOAuth } from '@/server/integrations/connections';
import { isProviderSlug, providerFromSlug } from '@/server/integrations/registry';
import { isIntegrationError } from '@/server/integrations/types';

function back(path: string, params: Record<string, string>) {
  const url = new URL(appUrl(path));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url, 303);
}

/** OAuth redirect target (GET, as issued by Google / Zoom). */
export async function GET(req: NextRequest, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  if (!isProviderSlug(provider)) return back('/integrations', { error: 'unknown_provider' });
  const auth = await getAuth();
  if (!auth) return back('/login', { next: '/integrations' });
  const params = req.nextUrl.searchParams;
  const error = params.get('error');
  if (error) return back('/integrations', { error: error === 'access_denied' ? 'access_denied' : 'oauth_error', provider });
  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return back('/integrations', { error: 'missing_code', provider });
  try {
    const { returnTo } = await completeOAuth(auth, providerFromSlug(provider), { code, state }, requestMeta(req));
    return back(returnTo, { connected: provider });
  } catch (err) {
    console.error(`[oauth] ${provider} callback failed:`, err instanceof Error ? err.message : err);
    const message = isAppError(err) ? err.message : isIntegrationError(err) ? 'The provider rejected the connection request.' : 'Connection failed.';
    return back('/integrations', { error: 'connect_failed', provider, message: message.slice(0, 200) });
  }
}
