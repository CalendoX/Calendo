import { z } from 'zod';
import { setSessionCookie } from '@/server/auth/session';
import { apiRoute, assertSameOrigin, json } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { parseJsonBody, zName, zTimeZone } from '@/server/http/validation';
import { enforceRateLimit, LIMITS } from '@/server/security/rate-limit';
import { acceptInvitation } from '@/server/services/auth-service';

const Body = z.object({ token: z.string().min(10).max(128), name: zName, password: z.string().min(1).max(128), timezone: zTimeZone });

export const POST = apiRoute(async (req) => {
  assertSameOrigin(req);
  const meta = requestMeta(req);
  await enforceRateLimit(`invite:ip:${meta.ip}`, LIMITS.signupPerIp.limit * 2, LIMITS.signupPerIp.window);
  const body = await parseJsonBody(req, Body);
  const { user, session } = await acceptInvitation(body.token, body, meta);
  await setSessionCookie(session.token, session.expiresAt);
  return json({ user: { id: user.id, name: user.name } });
});
