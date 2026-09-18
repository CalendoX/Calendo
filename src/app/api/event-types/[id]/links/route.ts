import { apiRoute, authenticate, json, noStore } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { parseJsonBody } from '@/server/http/validation';
import { createSchedulingLink, listSchedulingLinks, SchedulingLinkInputSchema } from '@/server/services/event-types-service';

export const GET = apiRoute<{ id: string }>(async (req, { id }) => {
  const auth = await authenticate(req);
  return noStore(json({ items: await listSchedulingLinks(auth, id) }));
});

export const POST = apiRoute<{ id: string }>(async (req, { id }) => {
  const auth = await authenticate(req);
  const body = await parseJsonBody(req, SchedulingLinkInputSchema);
  return json(await createSchedulingLink(auth, id, body, requestMeta(req)), 201);
});
