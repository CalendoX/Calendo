import { apiRoute, json, noStore, withPublicCors } from '@/server/http/handler';
import { LIMITS } from '@/server/security/rate-limit';
import { resolvePublicEventType } from '@/server/services/public-service';
import { limitPublic } from '../../../_shared';

/** Public details of a bookable event type (host, organisation, form configuration). */
export const GET = apiRoute<{ username: string; eventSlug: string }>(async (req, { username, eventSlug }) => {
  await limitPublic(req, 'public-page', LIMITS.publicPagePerIp);
  const link = req.nextUrl.searchParams.get('link');
  const { eventTypeId: _id, ...data } = await resolvePublicEventType(username, eventSlug, link);
  return withPublicCors(req, noStore(json(data)));
});
