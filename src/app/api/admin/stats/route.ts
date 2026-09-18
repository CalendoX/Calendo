import { apiRoute, authenticate, json, noStore } from '@/server/http/handler';
import { getAdminOverview } from '@/server/services/interviews-service';

export const GET = apiRoute(async (req) => {
  const auth = await authenticate(req);
  return noStore(json(await getAdminOverview(auth)));
});
