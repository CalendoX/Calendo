import { z } from 'zod';
import { NotFoundError } from '@/server/http/errors';
import { apiRoute, authenticate, json } from '@/server/http/handler';
import { beginOAuth } from '@/server/integrations/connections';
import { isProviderSlug, providerFromSlug } from '@/server/integrations/registry';

const Body = z.object({ returnTo: z.string().max(200).optional() });

/** Starts OAuth: returns the provider authorization URL (state + PKCE bound to this user). */
export const POST = apiRoute<{ provider: string }>(async (req, { provider }) => {
  const auth = await authenticate(req);
  if (!isProviderSlug(provider)) throw new NotFoundError('Unknown integration');
  const text = await req.text();
  const body = Body.parse(text ? JSON.parse(text) : {});
  const url = await beginOAuth(auth, providerFromSlug(provider), body.returnTo);
  return json({ url });
});
