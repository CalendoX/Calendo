import { z } from 'zod';
import { apiRoute, assertSameOrigin, json } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { parseJsonBody } from '@/server/http/validation';
import { enforceRateLimit, LIMITS } from '@/server/security/rate-limit';
import { resetPassword } from '@/server/services/auth-service';

const Body = z.object({ token: z.string().min(10).max(128), password: z.string().min(1).max(128) });

export const POST = apiRoute(async (req) => {
  assertSameOrigin(req);
  const meta = requestMeta(req);
  await enforceRateLimit(`reset-confirm:ip:${meta.ip}`, LIMITS.passwordResetPerIp.limit, LIMITS.passwordResetPerIp.window);
  const body = await parseJsonBody(req, Body);
  await resetPassword(body.token, body.password, meta);
  return json({ ok: true });
});
