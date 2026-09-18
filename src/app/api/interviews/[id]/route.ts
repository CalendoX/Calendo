import { z } from 'zod';
import { assertCanManageInterview } from '@/server/authz/policy';
import { apiRoute, authenticate, json, noStore } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { parseJsonBody } from '@/server/http/validation';
import { setInterviewOutcome } from '@/server/scheduling/booking-service';
import { getInterviewDetails } from '@/server/services/interviews-service';
import { loadInterviewRow } from '../_shared';

export const GET = apiRoute<{ id: string }>(async (req, { id }) => {
  const auth = await authenticate(req);
  return noStore(json(await getInterviewDetails(auth, id)));
});

const Body = z.object({ status: z.enum(['completed', 'no_show']) });

export const PATCH = apiRoute<{ id: string }>(async (req, { id }) => {
  const auth = await authenticate(req);
  const interview = await loadInterviewRow(id);
  assertCanManageInterview(auth, interview);
  const { status } = await parseJsonBody(req, Body);
  const row = await setInterviewOutcome(id, status, { type: 'user', userId: auth.user.id }, requestMeta(req));
  return json({ status: row.status });
});
