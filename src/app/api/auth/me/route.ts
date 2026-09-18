import { apiRoute, authenticate, json, noStore } from '@/server/http/handler';

export const GET = apiRoute(async (req) => {
  const auth = await authenticate(req);
  return noStore(
    json({
      user: auth.user,
      organization: { id: auth.organization.id, name: auth.organization.name, slug: auth.organization.slug },
      role: auth.membership.role,
      memberships: auth.memberships,
    }),
  );
});
