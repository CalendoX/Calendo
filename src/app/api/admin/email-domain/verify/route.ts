import { apiRoute, authenticate, json } from '@/server/http/handler';
import { verifyEmailDomain } from '@/server/services/email-domain-service';

/** Re-check the domain's DNS records with the email provider now. */
export const POST = apiRoute(async (req) => {
  const auth = await authenticate(req);
  return json(await verifyEmailDomain(auth));
});
