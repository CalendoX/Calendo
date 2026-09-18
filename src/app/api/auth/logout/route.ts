import { clearSessionCookie, getAuth } from '@/server/auth/session';
import { apiRoute, assertSameOrigin, json } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { logout } from '@/server/services/auth-service';

export const POST = apiRoute(async (req) => {
  assertSameOrigin(req);
  const auth = await getAuth();
  if (auth) await logout(auth, requestMeta(req));
  await clearSessionCookie();
  return json({ ok: true });
});
