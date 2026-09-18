import { z } from 'zod';
import { requireAdmin } from '@/server/authz/policy';
import { apiRoute, authenticate, json, noStore } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { parseJsonBody, parseSearchParams, zEmail, zName } from '@/server/http/validation';
import { inviteMember, listMembers } from '@/server/services/team-service';

const Query = z.object({
  q: z.string().max(200).optional(),
  role: z.enum(['admin', 'recruiter', 'interviewer']).optional(),
  status: z.enum(['active', 'invited', 'deactivated']).optional(),
});

export const GET = apiRoute(async (req) => {
  const auth = await authenticate(req);
  requireAdmin(auth);
  const q = parseSearchParams(req.url, Query);
  return noStore(json({ items: await listMembers(auth, { search: q.q, role: q.role, status: q.status }) }));
});

const Body = z.object({
  name: zName,
  email: zEmail,
  role: z.enum(['admin', 'recruiter', 'interviewer']),
  title: z.string().trim().max(120).nullish(),
});

/** Creates an interviewer/recruiter/admin account and emails them an invitation. */
export const POST = apiRoute(async (req) => {
  const auth = await authenticate(req);
  const body = await parseJsonBody(req, Body);
  return json(await inviteMember(auth, body, requestMeta(req)), 201);
});
