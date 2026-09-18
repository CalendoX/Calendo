import { z } from 'zod';
import { assertCanManageEventType, canViewAllInterviews } from '@/server/authz/policy';
import { db } from '@/server/db/client';
import { eventTypes } from '@/server/db/schema';
import { eq } from 'drizzle-orm';
import { NotFoundError } from '@/server/http/errors';
import { apiRoute, authenticate, json, noStore } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { parseJsonBody, parseSearchParams, zEmail, zIsoInstant, zName, zTimeZone } from '@/server/http/validation';
import { bookInterview } from '@/server/scheduling/booking-service';
import { listInterviews } from '@/server/services/interviews-service';

const Query = z.object({
  view: z.enum(['upcoming', 'today', 'week', 'past', 'cancelled', 'rescheduled', 'all']).optional(),
  q: z.string().max(200).optional(),
  interviewerId: z.uuid().optional(),
  eventTypeId: z.uuid().optional(),
  status: z.enum(['scheduled', 'rescheduled', 'cancelled', 'completed', 'no_show']).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  sort: z.enum(['start_asc', 'start_desc', 'created_desc']).optional(),
  scope: z.enum(['mine', 'team']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export const GET = apiRoute(async (req) => {
  const auth = await authenticate(req);
  const q = parseSearchParams(req.url, Query);
  return noStore(json(await listInterviews(auth, q)));
});

/** Schedule an interview on behalf of a candidate (recruiter/admin, or the host themselves). */
const Body = z.object({
  eventTypeId: z.uuid(),
  start: zIsoInstant,
  candidate: z.object({
    name: zName,
    email: zEmail,
    phone: z.string().trim().max(40).nullish(),
    linkedinUrl: z.string().trim().max(500).nullish(),
    resumeUrl: z.string().trim().max(2000).nullish(),
    company: z.string().trim().max(200).nullish(),
    timezone: zTimeZone,
  }),
  answers: z.record(z.string(), z.string().max(5000)).default({}),
  ignoreWorkingHours: z.boolean().default(false),
});

export const POST = apiRoute(async (req) => {
  const auth = await authenticate(req);
  const body = await parseJsonBody(req, Body);
  const [et] = await db.select().from(eventTypes).where(eq(eventTypes.id, body.eventTypeId)).limit(1);
  if (!et || et.organizationId !== auth.organization.id) throw new NotFoundError('Event type not found');
  if (!canViewAllInterviews(auth)) assertCanManageEventType(auth, et);
  const result = await bookInterview({
    eventTypeId: et.id,
    start: body.start,
    candidate: body.candidate,
    answers: body.answers,
    source: 'dashboard',
    actor: { type: 'user', userId: auth.user.id },
    meta: requestMeta(req),
    hostOverrides: body.ignoreWorkingHours ? { ignoreWorkingHours: true, ignoreNotice: true } : undefined,
  });
  return json({ interviewId: result.interviewId }, 201);
});
