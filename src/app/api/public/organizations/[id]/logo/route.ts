import { NotFoundError } from '@/server/http/errors';
import { apiRoute } from '@/server/http/handler';
import { zUuid } from '@/server/http/validation';
import { getOrganizationLogo, logoVersion } from '@/server/services/organization-service';

/**
 * Serves an uploaded organisation logo to booking pages and email clients. Logo URLs carry
 * `?v=<content hash>`, so a request for the current version can be cached indefinitely.
 */
export const GET = apiRoute<{ id: string }>(async (req, { id }) => {
  const logo = zUuid.safeParse(id).success ? await getOrganizationLogo(id) : null;
  if (!logo) throw new NotFoundError('Logo not found');
  const current = new URL(req.url).searchParams.get('v') === logoVersion(logo.sha256);
  return new Response(new Uint8Array(logo.data), {
    headers: {
      'Content-Type': logo.contentType,
      'Cache-Control': current ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      'Content-Security-Policy': "default-src 'none'",
      ETag: `"${logo.sha256}"`,
    },
  });
});
