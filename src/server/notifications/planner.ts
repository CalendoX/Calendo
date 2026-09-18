import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Transaction } from '../db/client';
import {
  eventTypes,
  interviews,
  notifications,
  organizations,
  users,
  type NotificationType,
} from '../db/schema';
import { enqueue } from '../jobs/queue';
import { QUEUES } from '../jobs/definitions';

/**
 * Decides which notifications a scheduling event produces and persists them in the same
 * transaction as the change itself. Delivery happens in the background:
 *
 *  - confirmations (booking / reschedule) wait for the first integration sync so they can
 *    include the Zoom link (`waitForSync`), then are dispatched by the sync job
 *  - reminders are enqueued with `startAfter` = send time
 *  - cancellations are enqueued immediately
 *
 * Every row has a unique dedupe key, so replays never produce duplicate emails, and carries the
 * interview version it describes, so reminders for a superseded time are skipped.
 */

export const DEFAULT_REMINDER_OFFSETS = [1440, 60];

type InterviewRow = typeof interviews.$inferSelect;

interface PlanInput {
  interview: InterviewRow;
  candidate: { email: string; name: string };
  host: Pick<typeof users.$inferSelect, 'email' | 'name'>;
  organization: Pick<typeof organizations.$inferSelect, 'settings'>;
  eventType: Pick<typeof eventTypes.$inferSelect, 'reminderOffsetsMinutes'>;
}

export function reminderOffsetsFor(input: Pick<PlanInput, 'organization' | 'eventType'>): number[] {
  const offsets = input.eventType.reminderOffsetsMinutes ?? input.organization.settings.reminderOffsetsMinutes ?? DEFAULT_REMINDER_OFFSETS;
  return [...new Set(offsets.filter((o) => Number.isInteger(o) && o > 0 && o <= 60 * 24 * 14))].sort((a, b) => b - a);
}

interface NewNotification {
  type: NotificationType;
  recipientType: 'candidate' | 'host';
  recipientEmail: string;
  recipientName: string;
  waitForSync?: boolean;
  scheduledFor?: Date;
  dedupeKey: string;
  metadata?: Record<string, unknown>;
}

async function insertAndMaybeEnqueue(tx: Transaction, interview: InterviewRow, items: NewNotification[]) {
  if (items.length === 0) return;
  const rows = await tx
    .insert(notifications)
    .values(
      items.map((n) => ({
        organizationId: interview.organizationId,
        interviewId: interview.id,
        type: n.type,
        recipientType: n.recipientType,
        recipientEmail: n.recipientEmail,
        recipientName: n.recipientName,
        status: n.waitForSync ? ('pending' as const) : ('queued' as const),
        interviewVersion: interview.version,
        waitForSync: n.waitForSync ?? false,
        scheduledFor: n.scheduledFor ?? new Date(),
        dedupeKey: n.dedupeKey,
        metadata: n.metadata ?? {},
      })),
    )
    .onConflictDoNothing({ target: notifications.dedupeKey })
    .returning({ id: notifications.id, waitForSync: notifications.waitForSync, scheduledFor: notifications.scheduledFor });
  for (const row of rows) {
    if (row.waitForSync) continue;
    await enqueue(QUEUES.notificationDeliver, { notificationId: row.id }, { tx, startAfter: row.scheduledFor ?? undefined });
  }
}

function reminders(input: PlanInput): NewNotification[] {
  const { interview } = input;
  const now = Date.now();
  return reminderOffsetsFor(input)
    .map((offset) => ({ offset, at: new Date(interview.startAt.getTime() - offset * 60_000) }))
    // Skip reminders whose send time has passed or would arrive right after the confirmation.
    .filter(({ at }) => at.getTime() > now + 5 * 60_000)
    .map(({ offset, at }) => ({
      type: 'reminder' as const,
      recipientType: 'candidate' as const,
      recipientEmail: input.candidate.email,
      recipientName: input.candidate.name,
      scheduledFor: at,
      dedupeKey: `reminder:${interview.id}:v${interview.version}:${offset}`,
      metadata: { offsetMinutes: offset },
    }));
}

export async function planBooked(tx: Transaction, input: PlanInput) {
  const { interview } = input;
  await insertAndMaybeEnqueue(tx, interview, [
    {
      type: 'booking_confirmation',
      recipientType: 'candidate',
      recipientEmail: input.candidate.email,
      recipientName: input.candidate.name,
      waitForSync: true,
      dedupeKey: `booking_confirmation:${interview.id}`,
    },
    {
      type: 'host_booking_notification',
      recipientType: 'host',
      recipientEmail: input.host.email,
      recipientName: input.host.name,
      waitForSync: true,
      dedupeKey: `host_booking_notification:${interview.id}`,
    },
    ...reminders(input),
  ]);
}

export async function planRescheduled(
  tx: Transaction,
  input: PlanInput & { previous: { start: Date; end: Date }; rescheduledBy: 'candidate' | 'host' | 'admin'; reason: string | null },
) {
  const { interview } = input;
  // Any not-yet-sent confirmation for the old time is superseded by the reschedule email.
  await tx
    .update(notifications)
    .set({ status: 'skipped', lastError: 'Superseded by reschedule', updatedAt: new Date() })
    .where(
      and(
        eq(notifications.interviewId, interview.id),
        inArray(notifications.status, ['pending', 'queued']),
        inArray(notifications.type, ['booking_confirmation', 'host_booking_notification', 'reschedule_confirmation', 'host_reschedule_notification']),
      ),
    );
  const metadata = {
    previousStart: input.previous.start.toISOString(),
    previousEnd: input.previous.end.toISOString(),
    rescheduledBy: input.rescheduledBy,
    reason: input.reason,
  };
  await insertAndMaybeEnqueue(tx, interview, [
    {
      type: 'reschedule_confirmation',
      recipientType: 'candidate',
      recipientEmail: input.candidate.email,
      recipientName: input.candidate.name,
      waitForSync: true,
      dedupeKey: `reschedule_confirmation:${interview.id}:v${interview.version}`,
      metadata,
    },
    {
      type: 'host_reschedule_notification',
      recipientType: 'host',
      recipientEmail: input.host.email,
      recipientName: input.host.name,
      waitForSync: true,
      dedupeKey: `host_reschedule_notification:${interview.id}:v${interview.version}`,
      metadata,
    },
    ...reminders(input),
  ]);
}

export async function planCancelled(
  tx: Transaction,
  input: PlanInput & { cancelledBy: 'candidate' | 'host' | 'admin'; reason: string | null },
) {
  const { interview } = input;
  await tx
    .update(notifications)
    .set({ status: 'skipped', lastError: 'Interview cancelled', updatedAt: new Date() })
    .where(
      and(
        eq(notifications.interviewId, interview.id),
        inArray(notifications.status, ['pending', 'queued']),
        sql`${notifications.type} <> 'cancellation' AND ${notifications.type} <> 'host_cancellation_notification'`,
      ),
    );
  const metadata = { cancelledBy: input.cancelledBy, reason: input.reason };
  await insertAndMaybeEnqueue(tx, interview, [
    {
      type: 'cancellation',
      recipientType: 'candidate',
      recipientEmail: input.candidate.email,
      recipientName: input.candidate.name,
      dedupeKey: `cancellation:${interview.id}`,
      metadata,
    },
    {
      type: 'host_cancellation_notification',
      recipientType: 'host',
      recipientEmail: input.host.email,
      recipientName: input.host.name,
      dedupeKey: `host_cancellation_notification:${interview.id}`,
      metadata,
    },
  ]);
}

/**
 * Called by the integration sync once its first attempt finishes (success or failure):
 * releases confirmation emails that were waiting for the meeting link.
 */
export async function dispatchSyncGatedNotifications(tx: Transaction, interviewId: string) {
  const released = await tx
    .update(notifications)
    .set({ status: 'queued', updatedAt: new Date() })
    .where(and(eq(notifications.interviewId, interviewId), eq(notifications.status, 'pending'), eq(notifications.waitForSync, true)))
    .returning({ id: notifications.id });
  for (const n of released) {
    await enqueue(QUEUES.notificationDeliver, { notificationId: n.id }, { tx });
  }
  return released.length;
}

/** A follow-up email when the meeting link becomes available (or changes) after confirmation. */
export async function planMeetingDetailsUpdate(tx: Transaction, interview: InterviewRow, candidate: { email: string; name: string }, joinUrl: string) {
  const sentConfirmations = await tx
    .select({ id: notifications.id, metadata: notifications.metadata })
    .from(notifications)
    .where(
      and(
        eq(notifications.interviewId, interview.id),
        eq(notifications.recipientType, 'candidate'),
        eq(notifications.status, 'sent'),
        inArray(notifications.type, ['booking_confirmation', 'reschedule_confirmation', 'meeting_details_update']),
      ),
    );
  if (sentConfirmations.length === 0) return false; // nothing sent yet — the pending email will include the link
  const alreadyHasLink = sentConfirmations.some((n) => n.metadata?.meetingJoinUrl === joinUrl);
  if (alreadyHasLink) return false;
  await insertAndMaybeEnqueue(tx, interview, [
    {
      type: 'meeting_details_update',
      recipientType: 'candidate',
      recipientEmail: candidate.email,
      recipientName: candidate.name,
      dedupeKey: `meeting_details_update:${interview.id}:${Buffer.from(joinUrl).toString('base64url').slice(-40)}`,
    },
  ]);
  return true;
}
