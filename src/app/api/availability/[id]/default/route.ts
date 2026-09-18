import { apiRoute, authenticate, json } from '@/server/http/handler';
import { setDefaultSchedule } from '@/server/services/schedules-service';

export const POST = apiRoute<{ id: string }>(async (req, { id }) => {
  const auth = await authenticate(req);
  await setDefaultSchedule(auth, id);
  return json({ ok: true });
});
