import type { NextRequest } from 'next/server';
import { requestMeta } from '@/server/http/request';
import { enforceRateLimit } from '@/server/security/rate-limit';

export async function limitPublic(req: NextRequest, bucket: string, limit: { limit: number; window: number }) {
  const meta = requestMeta(req);
  await enforceRateLimit(`${bucket}:ip:${meta.ip}`, limit.limit, limit.window);
  return meta;
}
