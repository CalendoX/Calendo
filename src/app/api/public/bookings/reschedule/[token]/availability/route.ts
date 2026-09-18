import { z } from 'zod';
import { GoneError, NotFoundError } from '@/server/http/errors';
import { apiRoute, json, noStore } from '@/server/http/handler';
import { parseSearchParams, zIsoInstant } from '@/server/http/validation';
import { getBookableSlots } from '@/server/scheduling/availability-service';
import { lookupBookingToken } from '@/server/scheduling/booking-tokens';
import { LIMITS } from '@/server/security/rate-limit';
import { loadInterviewRow } from '@/app/api/interviews/_shared';
import { limitPublic } from '../../../../_shared';

const Query = z.object({ start: zIsoInstant, end: zIsoInstant });

export const GET = apiRoute<{ token: string }>(async (req, { token }) => {
  await limitPublic(req, 'public-availability', LIMITS.publicAvailabilityPerIp);
  const lookup = await lookupBookingToken(token, 'reschedule');
  if (!lookup.ok) {
    if (lookup.reason === 'not_found') throw new NotFoundError('This reschedule link is not valid.');
    throw new GoneError('This reschedule link is no longer valid.', `LINK_${lookup.reason.toUpperCase()}`);
  }
  const interview = await loadInterviewRow(lookup.interviewId);
  const q = parseSearchParams(req.url, Query);
  const result = await getBookableSlots({
    eventTypeId: interview.eventTypeId,
    rangeStart: q.start,
    rangeEnd: q.end,
    exclude: { interviewId: interview.id, start: interview.startAt, end: interview.endAt },
    overrides: {
      durationMinutes: Math.round((interview.endAt.getTime() - interview.startAt.getTime()) / 60_000),
      bufferBeforeMinutes: interview.bufferBeforeMinutes,
      bufferAfterMinutes: interview.bufferAfterMinutes,
    },
  });
  return noStore(json({ timezone: result.timezone, durationMinutes: result.durationMinutes, slots: result.slots }));
});
