import { z } from 'zod';
import { apiRoute, authenticate, json, noStore } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { parseJsonBody } from '@/server/http/validation';
import { getMemberDetails, updateMember } from '@/server/services/team-service';

export const GET = apiRoute<{ id: string }>(async (req, { id }) => {
  const auth = await authenticate(req);
  return noStore(json(await getMemberDetails(auth, id)));
});

const Body = z.object({
  role: z.enum(['admin', 'recruiter', 'interviewer']).optional(),
  status: z.enum(['active', 'deactivated']).optional(),
  title: z.string().trim().max(120).nullish(),
});

export const PATCH = apiRoute<{ id: string }>(async (req, { id }) => {
  const auth = await authenticate(req);
  const body = await parseJsonBody(req, Body);
  await updateMember(auth, id, body, requestMeta(req));
  return json({ ok: true });
});
