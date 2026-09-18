import { z } from 'zod';
import { apiRoute, assertSameOrigin, json } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { parseJsonBody, zEmail } from '@/server/http/validation';
import { enforceRateLimit, hitRateLimit, LIMITS } from '@/server/security/rate-limit';
import { requestPasswordReset } from '@/server/services/auth-service';

const Body = z.object({ email: zEmail });

export const POST = apiRoute(async (req) => {
  assertSameOrigin(req);
  const meta = requestMeta(req);
  await enforceRateLimit(`reset:ip:${meta.ip}`, LIMITS.passwordResetPerIp.limit, LIMITS.passwordResetPerIp.window);
  const { email } = await parseJsonBody(req, Body);
  const perEmail = await hitRateLimit(`reset:email:${email}`, LIMITS.passwordResetPerEmail.limit, LIMITS.passwordResetPerEmail.window);
  // Same response whether or not the account exists (no account enumeration).
  if (perEmail.allowed) await requestPasswordReset(email, meta);
  return json({ ok: true });
});
