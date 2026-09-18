import { apiRoute, authenticate, json, noStore } from '@/server/http/handler';
import { listIntegrationsForUser } from '@/server/integrations/connections';
import { pushNotificationsSupported } from '@/server/integrations/google/watch';

/** Connection status for the signed-in user. Never includes credentials. */
export const GET = apiRoute(async (req) => {
  const auth = await authenticate(req);
  return noStore(json({ items: await listIntegrationsForUser(auth.user.id), pushNotifications: pushNotificationsSupported() }));
});
