import { apiRoute, authenticate, json, noStore } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { parseJsonBody } from '@/server/http/validation';
import {
  addEmailDomain,
  EmailDomainInputSchema,
  EmailSenderSchema,
  getEmailDomain,
  removeEmailDomain,
  updateEmailSender,
} from '@/server/services/email-domain-service';

/** The organisation's own email sending domain (admin only). */
export const GET = apiRoute(async (req) => {
  const auth = await authenticate(req);
  return noStore(json(await getEmailDomain(auth)));
});

/** Connect a domain: registers it with the email provider and returns the DNS records to publish. */
export const POST = apiRoute(async (req) => {
  const auth = await authenticate(req);
  const body = await parseJsonBody(req, EmailDomainInputSchema);
  return json(await addEmailDomain(auth, body, requestMeta(req)), 201);
});

/** Change the sender name / address on the connected domain. */
export const PATCH = apiRoute(async (req) => {
  const auth = await authenticate(req);
  const body = await parseJsonBody(req, EmailSenderSchema);
  return json(await updateEmailSender(auth, body, requestMeta(req)));
});

export const DELETE = apiRoute(async (req) => {
  const auth = await authenticate(req);
  await removeEmailDomain(auth, requestMeta(req));
  return json({ removed: true });
});
