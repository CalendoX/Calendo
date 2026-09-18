import { z } from 'zod';
import { apiRoute, json, noStore, withPublicCors } from '@/server/http/handler';
import { parseSearchParams, zIsoInstant } from '@/server/http/validation';
import { getBookableSlots } from '@/server/scheduling/availability-service';
import { LIMITS } from '@/server/security/rate-limit';
import { resolvePublicEventType } from '@/server/services/public-service';
import { limitPublic } from '../../../_shared';

const Query = z.object({ start: zIsoInstant, end: zIsoInstant, link: z.string().max(128).optional() });

/**
 * Available start times (UTC ISO) in [start, end). Computed entirely server-side from working
 * hours, existing interviews, buffers, notice rules and live Google Calendar busy time.
 * Returns 503 CALENDAR_UNAVAILABLE rather than guessing when the calendar can't be read.
 */
export const GET = apiRoute<{ username: string; eventSlug: string }>(async (req, { username, eventSlug }) => {
  await limitPublic(req, 'public-availability', LIMITS.publicAvailabilityPerIp);
  const q = parseSearchParams(req.url, Query);
  const resolved = await resolvePublicEventType(username, eventSlug, q.link);
  const result = await getBookableSlots({ eventTypeId: resolved.eventTypeId, rangeStart: q.start, rangeEnd: q.end });
  return withPublicCors(req, noStore(json({ timezone: result.timezone, durationMinutes: result.durationMinutes, slots: result.slots })));
});
