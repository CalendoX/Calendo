import { apiRoute, authenticate, json, noStore } from '@/server/http/handler';
import { listSignupRequests } from '@/server/services/signup-approval-service';

/** Pending self-service sign-ups (platform admins only). */
export const GET = apiRoute(async (req) => {
  const auth = await authenticate(req);
  return noStore(json({ items: await listSignupRequests(auth) }));
});
