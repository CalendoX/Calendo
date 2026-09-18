import { z } from 'zod';
import { GoneError, NotFoundError } from '@/server/http/errors';
import { apiRoute, json } from '@/server/http/handler';
import { parseJsonBody } from '@/server/http/validation';
import { cancelInterview } from '@/server/scheduling/booking-service';
import { lookupBookingToken } from '@/server/scheduling/booking-tokens';
import { LIMITS } from '@/server/security/rate-limit';
import { limitPublic } from '../../../_shared';

const Body = z.object({ reason: z.string().trim().max(1000).nullish() });

/** Candidate self-service cancellation, authorised by the cancel token from their email. */
export const POST = apiRoute<{ token: string }>(async (req, { token }) => {
  const meta = await limitPublic(req, 'booking-manage', LIMITS.bookingManagePerIp);
  const lookup = await lookupBookingToken(token, 'cancel');
  if (!lookup.ok) {
    if (lookup.reason === 'not_found') throw new NotFoundError('This cancellation link is not valid.');
    throw new GoneError(
      lookup.reason === 'revoked' ? 'This interview has already been cancelled.' : 'This cancellation link has expired.',
      `LINK_${lookup.reason.toUpperCase()}`,
    );
  }
  const body = await parseJsonBody(req, Body);
  await cancelInterview({
    interviewId: lookup.interviewId,
    reason: body.reason,
    actor: { type: 'candidate', label: 'Candidate (cancellation link)' },
    actorRole: 'candidate',
    via: 'candidate_token',
    meta,
  });
  return json({ ok: true });
});
