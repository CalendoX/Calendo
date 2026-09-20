import { NotFoundError } from '@/server/http/errors';
import { apiRoute, authenticate, json } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { zUuid } from '@/server/http/validation';
import { declineSignup } from '@/server/services/signup-approval-service';

/** Declines a sign-up: removes the pending account and the organisation it created. */
export const POST = apiRoute<{ id: string }>(async (req, { id }) => {
  const auth = await authenticate(req);
  if (!zUuid.safeParse(id).success) throw new NotFoundError('This sign-up request no longer exists.');
  await declineSignup(auth, id, requestMeta(req));
  return json({ declined: true });
});
