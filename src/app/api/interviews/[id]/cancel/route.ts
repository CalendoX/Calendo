import { z } from 'zod';
import { assertCanManageInterview, isAdmin } from '@/server/authz/policy';
import { apiRoute, authenticate, json } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { parseJsonBody } from '@/server/http/validation';
import { cancelInterview } from '@/server/scheduling/booking-service';
import { loadInterviewRow } from '../../_shared';

const Body = z.object({ reason: z.string().trim().max(1000).nullish() });

export const POST = apiRoute<{ id: string }>(async (req, { id }) => {
  const auth = await authenticate(req);
  const interview = await loadInterviewRow(id);
  assertCanManageInterview(auth, interview);
  const body = await parseJsonBody(req, Body);
  const row = await cancelInterview({
    interviewId: id,
    reason: body.reason,
    actor: { type: 'user', userId: auth.user.id },
    actorRole: interview.hostUserId === auth.user.id ? 'host' : isAdmin(auth) ? 'admin' : 'host',
    via: 'dashboard',
    meta: requestMeta(req),
  });
  return json({ id: row.id, status: row.status });
});
