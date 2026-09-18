import { apiRoute, authenticate, json, noStore } from '@/server/http/handler';
import { listTemplates } from '@/server/services/organization-service';

export const GET = apiRoute(async (req) => {
  const auth = await authenticate(req);
  return noStore(json({ items: await listTemplates(auth) }));
});
