import { sql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { apiRoute, json } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/** Liveness/readiness probe: verifies database connectivity. */
export const GET = apiRoute(async () => {
  const started = Date.now();
  await db.execute(sql`select 1`);
  return json({ status: 'ok', database: 'ok', latencyMs: Date.now() - started, time: new Date().toISOString() });
});
