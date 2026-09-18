import { z } from 'zod';
import { apiRoute, authenticate, json, noStore } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { parseJsonBody, parseSearchParams } from '@/server/http/validation';
import { createEventType, EventTypeInputSchema, listEventTypes } from '@/server/services/event-types-service';

const Query = z.object({ scope: z.enum(['mine', 'all']).optional(), hostUserId: z.uuid().optional() });

export const GET = apiRoute(async (req) => {
  const auth = await authenticate(req);
  const q = parseSearchParams(req.url, Query);
  return noStore(json({ items: await listEventTypes(auth, q) }));
});

export const POST = apiRoute(async (req) => {
  const auth = await authenticate(req);
  const body = await parseJsonBody(req, EventTypeInputSchema);
  const row = await createEventType(auth, body, requestMeta(req));
  return json({ id: row.id, slug: row.slug }, 201);
});
