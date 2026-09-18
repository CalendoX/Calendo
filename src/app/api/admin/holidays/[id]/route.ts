import { apiRoute, authenticate, json } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { removeHoliday } from '@/server/services/organization-service';

export const DELETE = apiRoute<{ id: string }>(async (req, { id }) => {
  const auth = await authenticate(req);
  await removeHoliday(auth, id, requestMeta(req));
  return json({ ok: true });
});
