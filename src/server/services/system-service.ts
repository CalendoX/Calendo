import { sql } from 'drizzle-orm';
import { env, googleConfig, webhookBaseUrl, zoomConfig } from '../config/env';
import { db } from '../db/client';
import { pushNotificationsSupported } from '../integrations/google/watch';
import { QUEUES } from '../jobs/definitions';
import { getProducer } from '../jobs/queue';
import { getWebhookStats } from './interviews-service';

/** Operational status for administrators. Contains configuration *presence*, never secrets. */
export async function getSystemStatus() {
  const e = env();
  const started = Date.now();
  let database: { ok: boolean; latencyMs: number | null } = { ok: false, latencyMs: null };
  try {
    await db.execute(sql`select 1`);
    database = { ok: true, latencyMs: Date.now() - started };
  } catch {
    /* reported as not ok */
  }
  let queues: { name: string; ready: number; deferred: number; active: number; failed: number }[] = [];
  let queueError: string | null = null;
  try {
    const boss = await getProducer();
    const rows = await boss.getQueues(Object.values(QUEUES));
    queues = rows.map((q) => ({ name: q.name, ready: q.readyCount, deferred: q.deferredCount, active: q.activeCount, failed: q.failedCount }));
  } catch (err) {
    queueError = err instanceof Error ? err.message : 'Queue unavailable';
  }
  const workerHeartbeat = await db
    .execute<{ last: Date | null }>(sql`select max(completed_on) as last from pgboss.job where state = 'completed' and completed_on > now() - interval '1 day'`)
    .then((r) => r.rows[0]?.last ?? null)
    .catch(() => null);
  const google = googleConfig();
  const zoom = zoomConfig();
  return {
    appUrl: e.APP_URL,
    environment: e.NODE_ENV,
    email: { provider: e.EMAIL_PROVIDER, from: e.EMAIL_FROM, smtpHost: e.EMAIL_PROVIDER === 'smtp' ? e.SMTP_HOST ?? null : null },
    google: { configured: Boolean(google), redirectUri: google?.redirectUri ?? null, webhookUrl: `${webhookBaseUrl()}/api/webhooks/google`, pushSupported: pushNotificationsSupported() },
    zoom: { configured: Boolean(zoom), redirectUri: zoom?.redirectUri ?? null, webhookConfigured: Boolean(zoom?.webhookSecretToken), webhookUrl: `${webhookBaseUrl()}/api/webhooks/zoom` },
    database,
    queues,
    queueError,
    lastJobCompletedAt: workerHeartbeat ? new Date(workerHeartbeat).toISOString() : null,
    webhooks: await getWebhookStats(),
  };
}
