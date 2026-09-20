import { NotFoundError } from '@/server/http/errors';
import { apiRoute, authenticate, json } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { zUuid } from '@/server/http/validation';
import { approveSignup } from '@/server/services/signup-approval-service';

export const POST = apiRoute<{ id: string }>(async (req, { id }) => {
  const auth = await authenticate(req);
  if (!zUuid.safeParse(id).success) throw new NotFoundError('This sign-up request no longer exists.');
  await approveSignup(auth, id, requestMeta(req));
  return json({ approved: true });
});
