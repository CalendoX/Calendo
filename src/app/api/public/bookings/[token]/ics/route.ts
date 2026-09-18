import { eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { videoMeetings } from '@/server/db/schema';
import { NotFoundError } from '@/server/http/errors';
import { apiRoute } from '@/server/http/handler';
import { buildIcs } from '@/server/notifications/ics';
import { loadInterviewForCandidate } from '@/server/scheduling/booking-service';
import { lookupBookingToken } from '@/server/scheduling/booking-tokens';
import { LIMITS } from '@/server/security/rate-limit';
import { appUrl } from '@/server/config/env';
import { locationLabel } from '@/lib/format';
import { limitPublic } from '../../../_shared';

/** "Add to calendar" (.ics) download for the candidate. */
export const GET = apiRoute<{ token: string }>(async (req, { token }) => {
  await limitPublic(req, 'booking-manage', LIMITS.bookingManagePerIp);
  const lookup = await lookupBookingToken(token, 'view');
  if (!lookup.ok) throw new NotFoundError('Booking not found');
  const row = await loadInterviewForCandidate(lookup.interviewId);
  if (!row) throw new NotFoundError('Booking not found');
  const [meeting] = await db.select().from(videoMeetings).where(eq(videoMeetings.interviewId, row.interview.id)).limit(1);
  const cancelled = row.interview.status === 'cancelled';
  const joinUrl = meeting?.status === 'synced' ? meeting.joinUrl : null;
  const ics = buildIcs({
    uid: `interview-${row.interview.id}@slate`,
    sequence: row.interview.version,
    method: cancelled ? 'CANCEL' : 'REQUEST',
    start: row.interview.startAt,
    end: row.interview.endAt,
    summary: `${row.eventType.name} with ${row.host.name}`,
    description: [joinUrl ? `Join: ${joinUrl}` : '', `Details: ${appUrl(`/booking/${token}`)}`].filter(Boolean).join('\n'),
    location: row.interview.locationType === 'zoom' ? joinUrl : locationLabel(row.interview.locationType, row.interview.locationDetails),
    url: appUrl(`/booking/${token}`),
    organizer: { name: row.host.name, email: row.host.email },
    attendee: { name: row.candidate.name, email: row.candidate.email },
    status: cancelled ? 'CANCELLED' : 'CONFIRMED',
  });
  return new Response(ics, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="interview.ics"',
      'Cache-Control': 'no-store',
    },
  });
});
