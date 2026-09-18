import { apiRoute, authenticate, json } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { parseJsonBody } from '@/server/http/validation';
import { OrganizationSettingsSchema, updateOrganization } from '@/server/services/organization-service';

export const PATCH = apiRoute(async (req) => {
  const auth = await authenticate(req);
  const body = await parseJsonBody(req, OrganizationSettingsSchema);
  const row = await updateOrganization(auth, body, requestMeta(req));
  return json({ id: row.id, name: row.name });
});
