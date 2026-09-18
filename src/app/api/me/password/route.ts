import { z } from 'zod';
import { apiRoute, authenticate, json } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { parseJsonBody } from '@/server/http/validation';
import { enforceRateLimit, LIMITS } from '@/server/security/rate-limit';
import { changePassword } from '@/server/services/auth-service';

const Body = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(1).max(128) });

export const POST = apiRoute(async (req) => {
  const auth = await authenticate(req);
  await enforceRateLimit(`password-change:${auth.user.id}`, LIMITS.loginPerEmail.limit, LIMITS.loginPerEmail.window);
  const body = await parseJsonBody(req, Body);
  await changePassword(auth, body.currentPassword, body.newPassword, requestMeta(req));
  return json({ ok: true });
});
