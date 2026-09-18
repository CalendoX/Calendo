import { z } from 'zod';
import { assertCanManageInterview, isAdmin } from '@/server/authz/policy';
import { apiRoute, authenticate, json } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { parseJsonBody, zIsoInstant } from '@/server/http/validation';
import { rescheduleInterview } from '@/server/scheduling/booking-service';
import { loadInterviewRow } from '../../_shared';

const Body = z.object({
  start: zIsoInstant,
  reason: z.string().trim().max(1000).nullish(),
  ignoreWorkingHours: z.boolean().default(false),
});

export const POST = apiRoute<{ id: string }>(async (req, { id }) => {
  const auth = await authenticate(req);
  const interview = await loadInterviewRow(id);
  assertCanManageInterview(auth, interview);
  const body = await parseJsonBody(req, Body);
  const row = await rescheduleInterview({
    interviewId: id,
    newStart: body.start,
    reason: body.reason,
    actor: { type: 'user', userId: auth.user.id },
    actorRole: interview.hostUserId === auth.user.id ? 'host' : isAdmin(auth) ? 'admin' : 'host',
    via: 'dashboard',
    meta: requestMeta(req),
    hostOverrides: body.ignoreWorkingHours ? { ignoreWorkingHours: true, ignoreNotice: true } : undefined,
  });
  return json({ id: row.id, startAt: row.startAt.toISOString(), endAt: row.endAt.toISOString(), status: row.status });
});
