import { z } from 'zod';
import { apiRoute, authenticate, json, noStore } from '@/server/http/handler';
import { parseSearchParams, zIsoInstant } from '@/server/http/validation';
import { listInterviewsInRange } from '@/server/services/interviews-service';

const Query = z.object({
  start: zIsoInstant,
  end: zIsoInstant,
  scope: z.enum(['mine', 'team']).optional(),
  interviewerId: z.uuid().optional(),
  includeCancelled: z.enum(['true', 'false']).optional(),
});

export const GET = apiRoute(async (req) => {
  const auth = await authenticate(req);
  const q = parseSearchParams(req.url, Query);
  const end = new Date(Math.min(q.end.getTime(), q.start.getTime() + 62 * 24 * 60 * 60 * 1000));
  const items = await listInterviewsInRange(auth, {
    start: q.start,
    end,
    scope: q.scope,
    interviewerId: q.interviewerId,
    includeCancelled: q.includeCancelled === 'true',
  });
  return noStore(json({ items }));
});
