import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { db } from '../../src/server/db/client';
import { notifications } from '../../src/server/db/schema';
import { deliverNotification } from '../../src/server/notifications/deliver';
import { decrypt } from '../../src/server/security/crypto';

/** Empties every application table (and the job queue) so each test starts from a clean slate. */
export async function resetDatabase() {
  const { rows } = await db.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '\\_\\_%'`,
  );
  if (rows.length) {
    const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
    await db.execute(sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`));
  }
  await db.execute(sql`TRUNCATE pgboss.job`);
}

export interface QueuedJob<T = Record<string, unknown>> {
  id: string;
  name: string;
  data: T;
  state: string;
  startAfter: Date;
  singletonKey: string | null;
}

/** Jobs currently in the pg-boss queue (optionally for one queue). */
export async function jobs<T = Record<string, unknown>>(name?: string): Promise<QueuedJob<T>[]> {
  const { rows } = await db.execute<{ id: string; name: string; data: T; state: string; start_after: Date; singleton_key: string | null }>(
    name
      ? sql`SELECT id, name, data, state, start_after, singleton_key FROM pgboss.job WHERE name = ${name} ORDER BY created_on`
      : sql`SELECT id, name, data, state, start_after, singleton_key FROM pgboss.job ORDER BY created_on`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, data: r.data, state: r.state, startAfter: new Date(r.start_after), singletonKey: r.singleton_key }));
}

/** The URL inside the most recent account email (verification / reset / invitation) sent to `to`. */
export async function lastAccountEmailUrl(
  to: string,
  kind?: 'verify_email' | 'password_reset' | 'invitation' | 'signup_request' | 'account_approved' | 'signup_declined',
) {
  const all = await jobs<{ kind: string; to: string; encryptedUrl: string }>('account-email');
  const match = all.filter((j) => j.data.to === to && (!kind || j.data.kind === kind)).at(-1);
  if (!match) throw new Error(`No ${kind ?? 'account'} email queued for ${to}`);
  return new URL(decrypt(match.data.encryptedUrl));
}

/**
 * Runs the notification worker logic for every queued notification that is due — the same
 * code path the `notification-deliver` job executes.
 */
export async function deliverDueNotifications(now = new Date()) {
  const due = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.status, 'queued'), lte(notifications.scheduledFor, now)))
    .orderBy(asc(notifications.createdAt));
  const results = [];
  for (const n of due) results.push(await deliverNotification(n.id));
  return results;
}

export async function notificationsFor(interviewId: string) {
  return db.select().from(notifications).where(eq(notifications.interviewId, interviewId)).orderBy(asc(notifications.scheduledFor));
}
