import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { canViewAllInterviews, assertCanManageEventType } from '@/server/authz/policy';
import { db } from '@/server/db/client';
import { eventTypes } from '@/server/db/schema';
import { NotFoundError } from '@/server/http/errors';
import { apiRoute, authenticate, json, noStore } from '@/server/http/handler';
import { parseSearchParams, zIsoInstant } from '@/server/http/validation';
import { getBookableSlots } from '@/server/scheduling/availability-service';

const Query = z.object({ start: zIsoInstant, end: zIsoInstant });

/** Bookable slots for an event type, for team members scheduling on a candidate's behalf. */
export const GET = apiRoute<{ id: string }>(async (req, { id }) => {
  const auth = await authenticate(req);
  const [et] = await db.select().from(eventTypes).where(eq(eventTypes.id, id)).limit(1);
  if (!et || et.organizationId !== auth.organization.id) throw new NotFoundError('Event type not found');
  if (!canViewAllInterviews(auth)) assertCanManageEventType(auth, et);
  const q = parseSearchParams(req.url, Query);
  return noStore(json(await getBookableSlots({ eventTypeId: id, rangeStart: q.start, rangeEnd: q.end })));
});
