import { z } from 'zod';
import { setSessionCookie } from '@/server/auth/session';
import { apiRoute, assertSameOrigin, json } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { parseJsonBody, zEmail } from '@/server/http/validation';
import { enforceRateLimit, LIMITS } from '@/server/security/rate-limit';
import { login } from '@/server/services/auth-service';

const Body = z.object({ email: zEmail, password: z.string().min(1).max(128) });

export const POST = apiRoute(async (req) => {
  assertSameOrigin(req);
  const meta = requestMeta(req);
  await enforceRateLimit(`login:ip:${meta.ip}`, LIMITS.loginPerIp.limit, LIMITS.loginPerIp.window);
  const body = await parseJsonBody(req, Body);
  await enforceRateLimit(`login:email:${body.email}`, LIMITS.loginPerEmail.limit, LIMITS.loginPerEmail.window);
  const { user, session } = await login(body.email, body.password, meta);
  await setSessionCookie(session.token, session.expiresAt);
  return json({ user: { id: user.id, name: user.name, email: user.email } });
});
