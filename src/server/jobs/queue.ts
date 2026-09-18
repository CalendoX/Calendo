import { sql } from 'drizzle-orm';
import { fromDrizzle, PgBoss, type SendOptions } from 'pg-boss';
import { env } from '../config/env';
import type { Transaction } from '../db/client';
import { QUEUE_CONFIG, QUEUES, type JobPayloads, type QueueName } from './definitions';

declare global {
  var __slateBoss: Promise<PgBoss> | undefined;
}

export function createBoss(opts: { worker: boolean }): PgBoss {
  const e = env();
  const boss = new PgBoss({
    connectionString: e.DATABASE_URL,
    ssl: e.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
    max: opts.worker ? Math.max(4, e.WORKER_CONCURRENCY + 2) : 3,
    application_name: opts.worker ? 'slate-worker' : 'slate-web',
    // Only the worker runs maintenance, cron and schema migrations.
    supervise: opts.worker,
    schedule: opts.worker,
    migrate: opts.worker,
    createSchema: opts.worker,
  });
  boss.on('error', (err) => console.error('[queue] error', err));
  return boss;
}

/** Producer-side pg-boss instance used by the web application to enqueue jobs. */
export function getProducer(): Promise<PgBoss> {
  if (!globalThis.__slateBoss) {
    const boss = createBoss({ worker: false });
    globalThis.__slateBoss = boss.start().catch((err) => {
      globalThis.__slateBoss = undefined;
      throw err;
    });
  }
  return globalThis.__slateBoss;
}

export async function stopProducer() {
  if (globalThis.__slateBoss) {
    const boss = await globalThis.__slateBoss.catch(() => null);
    globalThis.__slateBoss = undefined;
    await boss?.stop({ graceful: false }).catch(() => undefined);
  }
}

export interface EnqueueOptions extends Omit<SendOptions, 'db'> {
  /** Enqueue atomically with the given transaction: the job exists iff the transaction commits. */
  tx?: Transaction;
}

export async function enqueue<Q extends QueueName>(
  queue: Q,
  data: JobPayloads[Q],
  options: EnqueueOptions = {},
): Promise<string | null> {
  const { tx, ...rest } = options;
  const boss = await getProducer();
  // Retry/expiry policy is inherited from the queue definition (QUEUE_CONFIG).
  const sendOptions: SendOptions = { ...rest };
  if (tx) sendOptions.db = fromDrizzle(tx, sql);
  return boss.send(queue, data as object, sendOptions);
}

/**
 * Schedule integration reconciliation for an interview. The `stately` queue policy keyed by
 * interview id collapses bursts of changes into at most one queued + one running job.
 */
export function enqueueInterviewSync(interviewId: string, reason: string, tx?: Transaction) {
  return enqueue(QUEUES.interviewSync, { interviewId, reason }, { tx, singletonKey: interviewId });
}

/** Ensures all queues exist with the configured policies (idempotent). */
export async function ensureQueues(boss: PgBoss) {
  // Dead-letter target must exist before queues that reference it.
  const names = [QUEUES.deadLetter, ...Object.values(QUEUES).filter((q) => q !== QUEUES.deadLetter)];
  for (const name of names) {
    const config = QUEUE_CONFIG[name];
    const existing = await boss.getQueue(name);
    if (!existing) {
      await boss.createQueue(name, config);
    } else {
      const { policy: _policy, deadLetter: _dl, ...updatable } = config as Record<string, unknown>;
      await boss.updateQueue(name, updatable);
    }
  }
}
