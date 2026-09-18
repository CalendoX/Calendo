import { notificationTypes, type NotificationType } from '@/server/db/schema';
import { NotFoundError } from '@/server/http/errors';
import { apiRoute, authenticate, json } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { parseJsonBody } from '@/server/http/validation';
import { TemplateInputSchema, upsertTemplate } from '@/server/services/organization-service';

export const PUT = apiRoute<{ type: string }>(async (req, { type }) => {
  const auth = await authenticate(req);
  if (!(notificationTypes as readonly string[]).includes(type)) throw new NotFoundError('Unknown template');
  const body = await parseJsonBody(req, TemplateInputSchema);
  await upsertTemplate(auth, type as NotificationType, body, requestMeta(req));
  return json({ ok: true });
});
