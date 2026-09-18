import { z } from 'zod';
import { switchOrganization } from '@/server/auth/session';
import { NotFoundError } from '@/server/http/errors';
import { apiRoute, authenticate, json } from '@/server/http/handler';
import { parseJsonBody } from '@/server/http/validation';

const Body = z.object({ organizationId: z.uuid() });

export const POST = apiRoute(async (req) => {
  const auth = await authenticate(req);
  const { organizationId } = await parseJsonBody(req, Body);
  if (!(await switchOrganization(auth.sessionId, auth.user.id, organizationId))) throw new NotFoundError('Organization not found');
  return json({ ok: true });
});
