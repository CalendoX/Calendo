import { z } from 'zod';
import { apiRoute, json, withPublicCors } from '@/server/http/handler';
import { parseJsonBody, zEmail, zIsoInstant, zName, zTimeZone } from '@/server/http/validation';
import { bookInterview } from '@/server/scheduling/booking-service';
import { enforceRateLimit, LIMITS } from '@/server/security/rate-limit';
import { resolvePublicEventType } from '@/server/services/public-service';
import { limitPublic } from '../../../_shared';

const Body = z.object({
  start: zIsoInstant,
  name: zName,
  email: zEmail,
  phone: z.string().trim().max(40).nullish(),
  company: z.string().trim().max(200).nullish(),
  linkedinUrl: z.string().trim().max(500).nullish(),
  resumeUrl: z.string().trim().max(2000).nullish(),
  timezone: zTimeZone,
  answers: z.record(z.string().max(40), z.string().max(5000)).default({}),
  link: z.string().max(128).nullish(),
  idempotencyKey: z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/).nullish(),
});

/**
 * Books an interview. The slot is re-validated on the server inside a per-interviewer lock;
 * the client's view of availability is never trusted.
 */
export const POST = apiRoute<{ username: string; eventSlug: string }>(async (req, { username, eventSlug }) => {
  const meta = await limitPublic(req, 'public-book', LIMITS.publicBookingPerIp);
  const body = await parseJsonBody(req, Body);
  await enforceRateLimit(`public-book:email:${body.email}`, LIMITS.publicBookingPerEmail.limit, LIMITS.publicBookingPerEmail.window);
  const resolved = await resolvePublicEventType(username, eventSlug, body.link);
  const idempotencyKey = body.idempotencyKey ?? req.headers.get('idempotency-key');
  const result = await bookInterview({
    eventTypeId: resolved.eventTypeId,
    start: body.start,
    candidate: {
      name: body.name,
      email: body.email,
      phone: body.phone,
      company: body.company,
      linkedinUrl: body.linkedinUrl,
      resumeUrl: body.resumeUrl,
      timezone: body.timezone,
    },
    answers: body.answers,
    source: body.link ? 'scheduling_link' : 'public_page',
    schedulingLinkToken: body.link,
    idempotencyKey: idempotencyKey && /^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey) ? idempotencyKey : null,
    actor: { type: 'candidate', label: `${body.name} <${body.email}>` },
    meta,
  });
  return withPublicCors(
    req,
    json({ created: result.created, confirmationUrl: result.viewToken ? `/booking/${result.viewToken}` : null }, result.created ? 201 : 200),
  );
});
