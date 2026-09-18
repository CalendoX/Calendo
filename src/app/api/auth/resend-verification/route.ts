import { apiRoute, authenticate, json } from '@/server/http/handler';
import { enforceRateLimit, LIMITS } from '@/server/security/rate-limit';
import { resendVerification } from '@/server/services/auth-service';

export const POST = apiRoute(async (req) => {
  const auth = await authenticate(req);
  await enforceRateLimit(`verify-resend:${auth.user.id}`, LIMITS.verificationResendPerUser.limit, LIMITS.verificationResendPerUser.window);
  await resendVerification(auth);
  return json({ ok: true });
});
