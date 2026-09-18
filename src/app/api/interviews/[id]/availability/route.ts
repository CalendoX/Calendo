import { z } from 'zod';
import { assertCanManageInterview } from '@/server/authz/policy';
import { apiRoute, authenticate, json, noStore } from '@/server/http/handler';
import { parseSearchParams, zIsoInstant } from '@/server/http/validation';
import { getBookableSlots } from '@/server/scheduling/availability-service';
import { loadInterviewRow } from '../../_shared';

const Query = z.object({ start: zIsoInstant, end: zIsoInstant, ignoreWorkingHours: z.enum(['true', 'false']).optional() });

/** Slots for rescheduling an interview (its own time is treated as free). */
export const GET = apiRoute<{ id: string }>(async (req, { id }) => {
  const auth = await authenticate(req);
  const interview = await loadInterviewRow(id);
  assertCanManageInterview(auth, interview);
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
  return noStore(json(result));
});
