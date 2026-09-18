import { z } from 'zod';
import { requireAdmin } from '@/server/authz/policy';
import { apiRoute, authenticate, json, noStore } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { parseJsonBody } from '@/server/http/validation';
import { addHoliday, listHolidays } from '@/server/services/organization-service';

export const GET = apiRoute(async (req) => {
  const auth = await authenticate(req);
  requireAdmin(auth);
  return noStore(json({ items: await listHolidays(auth) }));
});

const Body = z.object({ date: z.iso.date(), name: z.string().trim().min(1).max(120) });

export const POST = apiRoute(async (req) => {
  const auth = await authenticate(req);
  const body = await parseJsonBody(req, Body);
  return json(await addHoliday(auth, body, requestMeta(req)), 201);
});
