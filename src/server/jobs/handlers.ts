import { and, eq, gt, inArray, isNotNull, lt, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  calendarEvents,
  interviews,
  notifications,
  oauthStates,
  rateLimits,
  sessions,
  userTokens,
  videoMeetings,
  webhookEvents,
} from '../db/schema';
import { renewExpiringChannels } from '../integrations/google/watch';
import { syncInterviewIntegrations } from '../integrations/sync';
import { processWebhookEvent } from '../integrations/webhooks';
import { deliverNotification } from '../notifications/deliver';
import { sendAccountEmail } from '../notifications/account-emails';
import type { JobPayloads } from './definitions';
import { dispatchSyncGatedNotifications } from '../notifications/planner';
import { enqueue, enqueueInterviewSync } from './queue';
import { QUEUES } from './definitions';

/**
 * Background job handlers. Each handler is idempotent: pg-boss guarantees at-least-once
 * execution, and failed jobs are retried with exponential backoff (see QUEUE_CONFIG).
 */

export interface JobMeta {
  retryCount: number;
  retryLimit: number;
}

const isFinal = (meta: JobMeta) => meta.retryCount >= meta.retryLimit;

export async function handleInterviewSync(data: { interviewId: string; reason: string }, meta: JobMeta) {
  const outcome = await syncInterviewIntegrations(data.interviewId, { waitForLeaseMs: 20_000 });
  if (outcome.skipped === 'lease_busy') throw new Error('Another sync for this interview is in progress; will retry');
  if (outcome.retryable && outcome.errors.length) {
    const message = `Integration sync incomplete: ${outcome.errors.join('; ')}`;
    if (isFinal(meta)) console.error(`[jobs] interview-sync giving up on ${data.interviewId}: ${message}`);
    throw new Error(message);
  }
  return outcome;
}

export async function handleNotificationDeliver(data: { notificationId: string }, meta: JobMeta) {
  return deliverNotification(data.notificationId, { finalAttempt: isFinal(meta) });
}

export async function handleAccountEmail(data: JobPayloads['account-email']) {
  await sendAccountEmail(data);
  return { kind: data.kind };
}

export async function handleWebhookProcess(data: { webhookEventId: string }, meta: JobMeta) {
  await processWebhookEvent(data.webhookEventId, { finalAttempt: isFinal(meta) });
}

export async function handleCalendarWatchRenew() {
  return renewExpiringChannels();
}

/** Deletes expired security artefacts and stale infrastructure rows. */
export async function handleMaintenanceCleanup() {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const s = await db
    .delete(sessions)
    .where(or(lt(sessions.expiresAt, weekAgo), and(isNotNull(sessions.revokedAt), lt(sessions.revokedAt, weekAgo))))
    .returning({ id: sessions.id });
  const t = await db
    .delete(userTokens)
    .where(or(lt(userTokens.expiresAt, weekAgo), and(isNotNull(userTokens.usedAt), lt(userTokens.usedAt, weekAgo))))
    .returning({ id: userTokens.id });
  const o = await db.delete(oauthStates).where(lt(oauthStates.expiresAt, new Date(now.getTime() - 60 * 60 * 1000))).returning({ id: oauthStates.id });
  const r = await db.delete(rateLimits).where(lt(rateLimits.expiresAt, now)).returning({ key: rateLimits.key });
  const w = await db
    .delete(webhookEvents)
    .where(and(inArray(webhookEvents.status, ['processed', 'ignored']), lt(webhookEvents.receivedAt, monthAgo)))
    .returning({ id: webhookEvents.id });
  return { sessions: s.length, userTokens: t.length, oauthStates: o.length, rateLimits: r.length, webhookEvents: w.length };
}

/** Marks interviews whose end time has passed as completed (hosts can then flag no-shows). */
export async function handleInterviewsComplete() {
  const rows = await db
    .update(interviews)
    .set({ status: 'completed', completedAt: sql`now()`, updatedAt: new Date() })
    .where(and(inArray(interviews.status, ['scheduled', 'rescheduled']), lt(interviews.endAt, new Date())))
    .returning({ id: interviews.id });
  return { completed: rows.length };
}

/** Safety net: integration records stuck in `pending` (e.g. a lost job) get re-enqueued. */
export async function handleSyncSweeper() {
  const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
  const ids = new Set<string>();
  for (const table of [videoMeetings, calendarEvents]) {
    const rows = await db
      .select({ interviewId: table.interviewId })
      .from(table)
      .innerJoin(interviews, eq(interviews.id, table.interviewId))
      .where(and(eq(table.status, 'pending'), lt(table.createdAt, staleBefore), gt(interviews.endAt, new Date())))
      .limit(200);
    rows.forEach((r) => ids.add(r.interviewId));
  }
  // Interviews whose integrations are synced for an older version (change not propagated).
  for (const table of [videoMeetings, calendarEvents]) {
    const rows = await db
      .select({ interviewId: table.interviewId })
      .from(table)
      .innerJoin(interviews, eq(interviews.id, table.interviewId))
      .where(
        and(
          eq(table.status, 'synced'),
          lt(table.syncedVersion, interviews.version),
          lt(interviews.updatedAt, staleBefore),
          gt(interviews.endAt, new Date()),
        ),
      )
      .limit(200);
    rows.forEach((r) => ids.add(r.interviewId));
  }
  for (const id of ids) await enqueueInterviewSync(id, 'sweeper');
  return { enqueued: ids.size };
}

/** Safety net for notifications: release confirmations whose sync never ran; re-enqueue lost jobs. */
export async function handleNotificationSweeper() {
  const now = Date.now();
  const gated = await db
    .selectDistinct({ interviewId: notifications.interviewId })
    .from(notifications)
    .where(
      and(
        eq(notifications.status, 'pending'),
        eq(notifications.waitForSync, true),
        lt(notifications.createdAt, new Date(now - 5 * 60 * 1000)),
      ),
    )
    .limit(200);
  let released = 0;
  for (const g of gated) {
    if (!g.interviewId) continue;
    released += await db.transaction((tx) => dispatchSyncGatedNotifications(tx, g.interviewId!));
  }
  const lost = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.status, 'queued'),
        eq(notifications.attempts, 0),
        lte(notifications.scheduledFor, new Date(now - 30 * 60 * 1000)),
      ),
    )
    .limit(200);
  for (const n of lost) await enqueue(QUEUES.notificationDeliver, { notificationId: n.id });
  return { released, requeued: lost.length };
}
