import { apiRoute, authenticate, json, noStore } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { parseJsonBody } from '@/server/http/validation';
import { deleteSchedule, getSchedule, ScheduleInputSchema, updateSchedule } from '@/server/services/schedules-service';

export const GET = apiRoute<{ id: string }>(async (req, { id }) => {
  const auth = await authenticate(req);
  return noStore(json(await getSchedule(auth, id)));
});

export const PUT = apiRoute<{ id: string }>(async (req, { id }) => {
  const auth = await authenticate(req);
  const body = await parseJsonBody(req, ScheduleInputSchema);
  return json(await updateSchedule(auth, id, body, requestMeta(req)));
});

export const DELETE = apiRoute<{ id: string }>(async (req, { id }) => {
  const auth = await authenticate(req);
  await deleteSchedule(auth, id, requestMeta(req));
  return json({ ok: true });
});
