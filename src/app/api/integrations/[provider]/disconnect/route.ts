import { NotFoundError } from '@/server/http/errors';
import { apiRoute, authenticate, json } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { disconnectIntegration } from '@/server/integrations/connections';
import { isProviderSlug, providerFromSlug } from '@/server/integrations/registry';

export const POST = apiRoute<{ provider: string }>(async (req, { provider }) => {
  const auth = await authenticate(req);
  if (!isProviderSlug(provider)) throw new NotFoundError('Unknown integration');
  await disconnectIntegration(auth, providerFromSlug(provider), requestMeta(req));
  return json({ ok: true });
});
