import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { webhookEvents, type IntegrationProvider } from '../db/schema';
import { enqueue } from '../jobs/queue';
import { QUEUES } from '../jobs/definitions';
import { processCalendarChanges } from './google/watch';
import { handleZoomEvent } from './zoom/webhooks';

/**
 * Webhook ingestion. Deliveries are stored once (unique provider + dedupe key) and processed
 * asynchronously by the worker, so duplicate deliveries are acknowledged without re-processing
 * and slow processing never causes provider timeouts.
 */

export async function recordWebhook(
  provider: IntegrationProvider,
  dedupeKey: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<{ id: string; duplicate: boolean }> {
  const inserted = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(webhookEvents)
      .values({ provider, dedupeKey: dedupeKey.slice(0, 500), eventType: eventType.slice(0, 120), payload })
      .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.dedupeKey] })
      .returning({ id: webhookEvents.id });
    if (rows.length) await enqueue(QUEUES.webhookProcess, { webhookEventId: rows[0].id }, { tx });
    return rows[0] ?? null;
  });
  if (inserted) return { id: inserted.id, duplicate: false };
  const [existing] = await db
    .select({ id: webhookEvents.id })
    .from(webhookEvents)
    .where(sql`${webhookEvents.provider} = ${provider} AND ${webhookEvents.dedupeKey} = ${dedupeKey.slice(0, 500)}`);
  return { id: existing?.id ?? '', duplicate: true };
}

export async function processWebhookEvent(id: string, opts: { finalAttempt?: boolean } = {}) {
  const [event] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, id)).limit(1);
  if (!event || event.status === 'processed' || event.status === 'ignored') return;
  try {
    let outcome: 'processed' | 'ignored' = 'processed';
    if (event.provider === 'google_calendar') {
      const channelId = String(event.payload.channelId ?? '');
      const result = await processCalendarChanges(channelId);
      if ('reason' in result) outcome = 'ignored';
    } else {
      outcome = await handleZoomEvent(event.payload as unknown as Parameters<typeof handleZoomEvent>[0]);
    }
    await db
      .update(webhookEvents)
      .set({ status: outcome, processedAt: new Date(), attempts: event.attempts + 1, error: null })
      .where(eq(webhookEvents.id, id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[webhooks] processing ${event.provider} event ${id} failed:`, message);
    await db
      .update(webhookEvents)
      .set({ status: opts.finalAttempt ? 'failed' : 'received', attempts: event.attempts + 1, error: message.slice(0, 1000) })
      .where(eq(webhookEvents.id, id));
    throw err;
  }
}
