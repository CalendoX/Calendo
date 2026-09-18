import { apiRoute, json, noStore } from '@/server/http/handler';
import { GoneError, NotFoundError } from '@/server/http/errors';
import { LIMITS } from '@/server/security/rate-limit';
import { getCandidateBooking } from '@/server/services/public-service';
import { limitPublic } from '../../_shared';

export const GET = apiRoute<{ token: string }>(async (req, { token }) => {
  await limitPublic(req, 'booking-manage', LIMITS.bookingManagePerIp);
  const result = await getCandidateBooking(token, 'view');
  if (!result.ok) {
    if (result.reason === 'not_found') throw new NotFoundError('Booking not found');
    throw new GoneError('This link is no longer valid.', `LINK_${result.reason.toUpperCase()}`);
  }
  return noStore(json(result.view));
});
