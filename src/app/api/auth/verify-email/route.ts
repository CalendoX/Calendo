import { z } from 'zod';
import { apiRoute, assertSameOrigin, json } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { parseJsonBody } from '@/server/http/validation';
import { verifyEmail } from '@/server/services/auth-service';

const Body = z.object({ token: z.string().min(10).max(128) });

export const POST = apiRoute(async (req) => {
  assertSameOrigin(req);
  const body = await parseJsonBody(req, Body);
  await verifyEmail(body.token, requestMeta(req));
  return json({ ok: true });
});
