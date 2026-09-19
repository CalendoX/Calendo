import { requireAdmin } from '@/server/authz/policy';
import { BadRequestError } from '@/server/http/errors';
import { apiRoute, authenticate, json } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { logoError, MAX_LOGO_BYTES, removeOrganizationLogo, uploadOrganizationLogo } from '@/server/services/organization-service';

/** Upload the organisation logo as multipart/form-data (field `file`). Replaces any existing logo. */
export const POST = apiRoute(async (req) => {
  const auth = await authenticate(req);
  requireAdmin(auth);
  if (!(req.headers.get('content-type') ?? '').includes('multipart/form-data')) {
    throw new BadRequestError('Expected multipart/form-data request body', 'UNSUPPORTED_MEDIA_TYPE');
  }
  // Reject oversized uploads before buffering them (allowing for multipart framing).
  if (Number(req.headers.get('content-length') ?? 0) > MAX_LOGO_BYTES + 16 * 1024) throw logoError('The logo must be 1 MB or smaller.');
  const form = await req.formData().catch(() => {
    throw new BadRequestError('Malformed form data', 'INVALID_FORM_DATA');
  });
  const file = form.get('file');
  if (!file || typeof file === 'string') throw logoError('Choose an image to upload.');
  if (file.size > MAX_LOGO_BYTES) throw logoError('The logo must be 1 MB or smaller.');
  return json(await uploadOrganizationLogo(auth, Buffer.from(await file.arrayBuffer()), requestMeta(req)));
});

export const DELETE = apiRoute(async (req) => {
  const auth = await authenticate(req);
  await removeOrganizationLogo(auth, requestMeta(req));
  return json({ logoUrl: null });
});
