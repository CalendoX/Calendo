import { z } from 'zod';
import { GoneError, NotFoundError } from '@/server/http/errors';
import { apiRoute, json } from '@/server/http/handler';
import { parseJsonBody, zIsoInstant, zTimeZone } from '@/server/http/validation';
import { rescheduleInterview } from '@/server/scheduling/booking-service';
import { lookupBookingToken } from '@/server/scheduling/booking-tokens';
import { bookingLinksFor } from '@/server/scheduling/booking-tokens';
import { LIMITS } from '@/server/security/rate-limit';
import { limitPublic } from '../../../_shared';

const Body = z.object({ start: zIsoInstant, timezone: zTimeZone, reason: z.string().trim().max(1000).nullish() });

/** Candidate self-service reschedule, authorised by the reschedule token from their email. */
export const POST = apiRoute<{ token: string }>(async (req, { token }) => {
  const meta = await limitPublic(req, 'booking-manage', LIMITS.bookingManagePerIp);
  const lookup = await lookupBookingToken(token, 'reschedule');
  if (!lookup.ok) {
    if (lookup.reason === 'not_found') throw new NotFoundError('This reschedule link is not valid.');
    throw new GoneError(
      lookup.reason === 'revoked' ? 'This interview can no longer be rescheduled.' : 'This reschedule link has expired.',
      `LINK_${lookup.reason.toUpperCase()}`,
    );
  }
  const body = await parseJsonBody(req, Body);
  const updated = await rescheduleInterview({
    interviewId: lookup.interviewId,
    newStart: body.start,
    reason: body.reason,
    candidateTimezone: body.timezone,
    actor: { type: 'candidate', label: 'Candidate (reschedule link)' },
    actorRole: 'candidate',
    via: 'candidate_token',
    meta,
  });
  const links = await bookingLinksFor(updated.id);
  return json({ startAt: updated.startAt.toISOString(), confirmationUrl: links.view ? new URL(links.view).pathname : null });
});
