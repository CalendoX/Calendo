import { z } from 'zod';
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
  // The account waits for a platform admin's approval: no session until then.
  const { user } = await signup(body, meta);
  return json({ user: { id: user.id, name: user.name, email: user.email }, pendingApproval: true }, 201);
});
