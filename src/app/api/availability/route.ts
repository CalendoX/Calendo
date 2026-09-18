import { z } from 'zod';
import { apiRoute, authenticate, json, noStore } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { parseJsonBody, zTimeZone } from '@/server/http/validation';
import { createSchedule, listSchedules } from '@/server/services/schedules-service';

export const GET = apiRoute(async (req) => {
  const auth = await authenticate(req);
  return noStore(json({ items: await listSchedules(auth) }));
});

const Body = z.object({ name: z.string().trim().min(1).max(80), timezone: zTimeZone, copyFromId: z.uuid().nullish() });

export const POST = apiRoute(async (req) => {
  const auth = await authenticate(req);
  const body = await parseJsonBody(req, Body);
  return json(await createSchedule(auth, body, requestMeta(req)), 201);
});
