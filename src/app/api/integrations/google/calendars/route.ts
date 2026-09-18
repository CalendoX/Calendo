import { z } from 'zod';
import { NotFoundError } from '@/server/http/errors';
import { apiRoute, authenticate, json } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { parseJsonBody } from '@/server/http/validation';
import { syncCalendarList, updateCalendarSelection } from '@/server/integrations/connections';
import { getIntegration } from '@/server/integrations/service';

const Body = z.object({ writeCalendarId: z.uuid().nullable(), conflictCalendarIds: z.array(z.uuid()).max(50) });

/** Choose which calendars are checked for conflicts and which one receives interviews. */
export const PATCH = apiRoute(async (req) => {
  const auth = await authenticate(req);
  const body = await parseJsonBody(req, Body);
  await updateCalendarSelection(auth, body, requestMeta(req));
  return json({ ok: true });
});

/** Re-reads the calendar list from Google. */
export const POST = apiRoute(async (req) => {
  const auth = await authenticate(req);
  const integration = await getIntegration(auth.user.id, 'google_calendar');
  if (!integration) throw new NotFoundError('Google Calendar is not connected');
  await syncCalendarList(integration.id);
  return json({ ok: true });
});
