import { z } from 'zod';
import { setSessionCookie } from '@/server/auth/session';
import { apiRoute, assertSameOrigin, json } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { parseJsonBody, zEmail, zName, zTimeZone } from '@/server/http/validation';
import { enforceRateLimit, LIMITS } from '@/server/security/rate-limit';
import { signup } from '@/server/services/auth-service';

const Body = z.object({
  name: zName,
  email: zEmail,
  password: z.string().min(1).max(128),
  organizationName: z.string().trim().min(1, 'Required').max(120),
  timezone: zTimeZone,
});

export const POST = apiRoute(async (req) => {
  assertSameOrigin(req);
  const meta = requestMeta(req);
  await enforceRateLimit(`signup:ip:${meta.ip}`, LIMITS.signupPerIp.limit, LIMITS.signupPerIp.window);
  const body = await parseJsonBody(req, Body);
  // Sign-up is open to everyone: the new organisation's founder is signed in immediately.
  const { user, session } = await signup(body, meta);
  await setSessionCookie(session.token, session.expiresAt);
  return json({ user: { id: user.id, name: user.name, email: user.email } }, 201);
});
