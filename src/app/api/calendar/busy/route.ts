import { z } from 'zod';
import { apiRoute, authenticate, json, noStore } from '@/server/http/handler';
import { parseSearchParams, zIsoInstant } from '@/server/http/validation';
import { getCalendarOverlay } from '@/server/integrations/service';

const Query = z.object({ start: zIsoInstant, end: zIsoInstant });

/**
 * The signed-in user's own Google Calendar for the calendar view: events with titles and guests,
 * plus busy blocks for calendars shared with them as free/busy only.
 */
export const GET = apiRoute(async (req) => {
  const auth = await authenticate(req);
  const q = parseSearchParams(req.url, Query);
  const end = Math.min(q.end.getTime(), q.start.getTime() + 35 * 24 * 60 * 60 * 1000);
  try {
    const result = await getCalendarOverlay(auth.user.id, { start: q.start.getTime(), end }, auth.user.timezone);
    return noStore(
      json({
        connected: result.connected,
        available: true,
        events: result.events.map((e) => ({ ...e, start: e.start.toISOString(), end: e.end.toISOString() })),
        busy: result.busy.map((b) => ({ start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString() })),
      }),
    );
  } catch {
    return noStore(json({ connected: true, available: false, events: [], busy: [] }));
  }
});
