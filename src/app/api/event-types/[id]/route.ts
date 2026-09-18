import { z } from 'zod';
import { apiRoute, authenticate, json, noStore } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { parseJsonBody } from '@/server/http/validation';
import {
  deleteEventType,
  EventTypeInputSchema,
  getEventType,
  setEventTypeActive,
  updateEventType,
} from '@/server/services/event-types-service';

export const GET = apiRoute<{ id: string }>(async (req, { id }) => {
  const auth = await authenticate(req);
  const { eventType, host, publicUrl } = await getEventType(auth, id);
  return noStore(json({ eventType, host, publicUrl }));
});

/** Full update (PUT semantics) or a partial `{ isActive }` toggle. */
export const PATCH = apiRoute<{ id: string }>(async (req, { id }) => {
  const auth = await authenticate(req);
  const text = await req.clone().text();
  const raw = text ? JSON.parse(text) : {};
  if (raw && typeof raw === 'object' && Object.keys(raw).length === 1 && 'isActive' in raw) {
    const { isActive } = z.object({ isActive: z.boolean() }).parse(raw);
    await setEventTypeActive(auth, id, isActive, requestMeta(req));
    return json({ ok: true });
  }
  const body = await parseJsonBody(req, EventTypeInputSchema);
  const row = await updateEventType(auth, id, body, requestMeta(req));
  return json({ id: row.id, slug: row.slug });
});

export const DELETE = apiRoute<{ id: string }>(async (req, { id }) => {
  const auth = await authenticate(req);
  await deleteEventType(auth, id, requestMeta(req));
  return json({ ok: true });
});
