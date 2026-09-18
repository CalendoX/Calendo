import { apiRoute, authenticate, json } from '@/server/http/handler';
import { resendInvitation } from '@/server/services/team-service';

export const POST = apiRoute<{ id: string }>(async (req, { id }) => {
  const auth = await authenticate(req);
  return json(await resendInvitation(auth, id));
});
