import { z } from 'zod';
import { apiRoute, authenticate, json, noStore } from '@/server/http/handler';
import { parseSearchParams, zIsoInstant } from '@/server/http/validation';
import { getAvailability } from '@/server/integrations/service';

const Query = z.object({ start: zIsoInstant, end: zIsoInstant });

/** The signed-in user's external calendar busy blocks (for the calendar overlay). */
export const GET = apiRoute(async (req) => {
  const auth = await authenticate(req);
  const q = parseSearchParams(req.url, Query);
  const end = Math.min(q.end.getTime(), q.start.getTime() + 35 * 24 * 60 * 60 * 1000);
  try {
    const result = await getAvailability(auth.user.id, { start: q.start.getTime(), end }, { allowCache: true });
    return noStore(
      json({
        connected: result.connected,
        available: true,
        busy: result.busy.map((b) => ({ start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString() })),
      }),
    );
  } catch {
    return noStore(json({ connected: true, available: false, busy: [] }));
  }
});
