/**
 * Calendor background worker.
 *
 * Runs every asynchronous task: integration sync (Zoom / Google Calendar), email delivery,
 * reminders, webhook processing and periodic maintenance. Run one or more instances alongside
 * the web app (`npm run worker`); pg-boss coordinates them through Postgres (SKIP LOCKED),
 * so scaling out is safe.
 */
import { config } from 'dotenv';
config({ quiet: true });

import type { JobWithMetadata } from 'pg-boss';
import { env } from '../server/config/env';
import { closeDb } from '../server/db/client';
import { QUEUES, SCHEDULES, type JobPayloads, type QueueName } from '../server/jobs/definitions';
import {
  handleAccountEmail,
  handleCalendarWatchRenew,
  handleInterviewsComplete,
  handleInterviewSync,
  handleMaintenanceCleanup,
  handleNotificationDeliver,
  handleNotificationSweeper,
  handleSyncSweeper,
  handleWebhookProcess,
  type JobMeta,
} from '../server/jobs/handlers';
import { createBoss, ensureQueues } from '../server/jobs/queue';

type Handler<Q extends QueueName> = (data: JobPayloads[Q], meta: JobMeta) => Promise<unknown>;

async function main() {
  const e = env();
  const boss = createBoss({ worker: true });
  boss.on('error', (err) => console.error('[worker] queue error', err));
  await boss.start();
  await ensureQueues(boss);

  for (const s of SCHEDULES) {
    await boss.schedule(s.queue, s.cron, {}, { tz: 'UTC' });
  }

  const register = async <Q extends QueueName>(queue: Q, handler: Handler<Q>, concurrency = e.WORKER_CONCURRENCY) => {
    await boss.work(
      queue,
      { includeMetadata: true, localConcurrency: concurrency, pollingIntervalSeconds: 1 },
      async (jobs: JobWithMetadata<object>[]) => {
        for (const job of jobs) {
          const started = Date.now();
          try {
            const result = await handler(job.data as JobPayloads[Q], { retryCount: job.retryCount, retryLimit: job.retryLimit });
            if (process.env.LOG_LEVEL === 'debug' || queue !== QUEUES.notificationDeliver) {
              console.info(`[worker] ${queue} ${job.id} ok in ${Date.now() - started}ms`, result ? JSON.stringify(result).slice(0, 300) : '');
            }
          } catch (err) {
            console.warn(
              `[worker] ${queue} ${job.id} failed (attempt ${job.retryCount + 1}/${job.retryLimit + 1}):`,
              err instanceof Error ? err.message : err,
            );
            throw err;
          }
        }
      },
    );
  };

  await register(QUEUES.interviewSync, handleInterviewSync);
  await register(QUEUES.notificationDeliver, handleNotificationDeliver);
  await register(QUEUES.accountEmail, handleAccountEmail);
  await register(QUEUES.webhookProcess, handleWebhookProcess);
  await register(QUEUES.calendarWatchRenew, handleCalendarWatchRenew, 1);
  await register(QUEUES.maintenanceCleanup, handleMaintenanceCleanup, 1);
  await register(QUEUES.interviewsComplete, handleInterviewsComplete, 1);
  await register(QUEUES.syncSweeper, handleSyncSweeper, 1);
  await register(QUEUES.notificationSweeper, handleNotificationSweeper, 1);

  console.info(`[worker] started — concurrency ${e.WORKER_CONCURRENCY}, email provider "${e.EMAIL_PROVIDER}"`);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.info(`[worker] ${signal} received, draining…`);
    await boss.stop({ graceful: true, timeout: 30_000 }).catch((err) => console.error('[worker] stop error', err));
    await closeDb().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(async (err) => {
  console.error('[worker] fatal', err);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
