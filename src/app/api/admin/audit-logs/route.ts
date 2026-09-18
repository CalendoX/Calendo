import { z } from 'zod';
import { requireAdmin } from '@/server/authz/policy';
import { apiRoute, authenticate, json, noStore } from '@/server/http/handler';
import { parseSearchParams } from '@/server/http/validation';
import { listAuditLogs } from '@/server/services/interviews-service';

const Query = z.object({
  q: z.string().max(200).optional(),
  action: z.string().max(80).optional(),
  actorId: z.uuid().optional(),
  resourceType: z.string().max(60).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

export const GET = apiRoute(async (req) => {
  const auth = await authenticate(req);
  requireAdmin(auth);
  return noStore(json(await listAuditLogs(auth, parseSearchParams(req.url, Query))));
});
