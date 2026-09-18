import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { POST as bookRoute } from '@/app/api/public/book/[username]/[eventSlug]/route';
import { PATCH as orgSettingsRoute } from '@/app/api/admin/organization/route';
import { PUT as templateRoute } from '@/app/api/admin/templates/[type]/route';
import { db } from '@/server/db/client';
import { interviews, notifications } from '@/server/db/schema';
import { cancelInterview } from '@/server/scheduling/booking-service';
import { handleNotificationSweeper } from '@/server/jobs/handlers';
import { deliverNotification } from '@/server/notifications/deliver';
import { deliverDueNotifications, jobs, notificationsFor } from '../helpers/db';
import { createEventType, createMember, createOrg, signIn, signOut, upcomingWeekday, type EventType, type Org, type User } from '../helpers/fixtures';
import { call } from '../helpers/http';
import { outbox } from '../helpers/outbox';

const TZ = 'America/New_York';

async function world(eventOverrides: Parameters<typeof createEventType>[2] = {}) {
  const org = await createOrg({ name: 'Northwind Labs' });
  const admin = await createMember(org, { role: 'admin' });
  const host = await createMember(org, { role: 'interviewer', name: 'Priya Nair', timezone: TZ });
  const eventType = await createEventType(org, host, { name: 'Technical Interview', ...eventOverrides });
  return { org, admin, host, eventType };
}

async function book(host: User, eventType: EventType, start: Date, email = `c-${randomUUID().slice(0, 6)}@candidate.test`, name = 'Riley Carter') {
  const res = await call(bookRoute, {
    path: '/x',
    params: { username: host.username, eventSlug: eventType.slug },
    body: { start: start.toISOString(), name, email, timezone: 'Europe/London', answers: {} },
    origin: false,
  });
  expect(res.status).toBe(201);
  const [row] = await db.select().from(notifications).where(eq(notifications.recipientEmail, email)).limit(1);
  return { email, interviewId: row.interviewId! };
}

async function updateSettings(org: Org, admin: User, settings: Record<string, unknown>) {
  await signIn(admin);
  const res = await call(orgSettingsRoute, {
    method: 'PATCH',
    path: '/x',
    body: {
      name: org.name,
      brandColor: '#0e7c66',
      logoUrl: null,
      defaultTimezone: TZ,
      settings: { reminderOffsetsMinutes: [1440, 60], candidateCanReschedule: true, candidateCanCancel: true, candidateManageCutoffMinutes: 60, addCandidateAsCalendarAttendee: false, ...settings },
    },
  });
  signOut();
  expect(res.status).toBe(200);
}

describe('reminders', () => {
  it('schedules reminders at the organisation-configured offsets through the job queue', async () => {
    const w = await world();
    await updateSettings(w.org, w.admin, { reminderOffsetsMinutes: [60, 2880, 30] });
    const start = upcomingWeekday(TZ, '10:00', 4);
    const { interviewId } = await book(w.host, w.eventType, start);
    const reminders = (await notificationsFor(interviewId)).filter((n) => n.type === 'reminder');
    expect(reminders.map((r) => r.metadata.offsetMinutes)).toEqual([2880, 60, 30]);
    for (const r of reminders) {
      expect(r.scheduledFor.getTime()).toBe(start.getTime() - (r.metadata.offsetMinutes as number) * 60_000);
      expect(r.status).toBe('queued');
    }
    // Each reminder is a delayed job — nothing is sent synchronously during the request.
    const delayed = (await jobs<{ notificationId: string }>('notification-deliver')).filter((j) => reminders.some((r) => r.id === j.data.notificationId));
    expect(delayed.map((j) => j.startAfter.getTime()).sort()).toEqual(reminders.map((r) => r.scheduledFor.getTime()).sort());
  });

  it('lets an event type override the organisation reminder schedule', async () => {
    const w = await world({ reminderOffsetsMinutes: [120] });
    const { interviewId } = await book(w.host, w.eventType, upcomingWeekday(TZ, '10:00'));
    const reminders = (await notificationsFor(interviewId)).filter((n) => n.type === 'reminder');
    expect(reminders.map((r) => r.metadata.offsetMinutes)).toEqual([120]);
  });

  it('sends a reminder when it comes due, and never for a cancelled interview', async () => {
    const w = await world();
    const { email, interviewId } = await book(w.host, w.eventType, upcomingWeekday(TZ, '10:00'));
    const [reminder] = (await notificationsFor(interviewId)).filter((n) => n.type === 'reminder');
    expect(await deliverNotification(reminder.id)).toBe('sent');
    const mail = outbox.to(email).find((m) => /reminder/i.test(m.subject))!;
    expect(mail.subject).toMatch(/Technical Interview/);
    expect(mail.text).toMatch(/Reschedule: http:\/\/localhost:3000\/booking\/reschedule\//);

    const other = await book(w.host, w.eventType, upcomingWeekday(TZ, '14:00'));
    const [pending] = (await notificationsFor(other.interviewId)).filter((n) => n.type === 'reminder');
    await db.update(interviews).set({ status: 'cancelled' }).where(eq(interviews.id, other.interviewId));
    expect(await deliverNotification(pending.id)).toBe('skipped');
  });
});

describe('delivery reliability', () => {
  it('delivers each notification once even if its job runs twice', async () => {
    const w = await world();
    const { email, interviewId } = await book(w.host, w.eventType, upcomingWeekday(TZ, '10:00'));
    const [confirmation] = (await notificationsFor(interviewId)).filter((n) => n.type === 'booking_confirmation');
    expect(await deliverNotification(confirmation.id)).toBe('sent');
    expect(await deliverNotification(confirmation.id)).toBe('already_done');
    expect(outbox.to(email)).toHaveLength(1);
  });

  it('keeps failed sends for retry and marks them failed after the last attempt', async () => {
    const w = await world();
    const { interviewId } = await book(w.host, w.eventType, upcomingWeekday(TZ, '10:00'));
    const [confirmation] = (await notificationsFor(interviewId)).filter((n) => n.type === 'booking_confirmation');

    outbox.failNext(1);
    await expect(deliverNotification(confirmation.id)).rejects.toThrow(/SMTP/);
    let [row] = await db.select().from(notifications).where(eq(notifications.id, confirmation.id));
    expect(row).toMatchObject({ status: 'queued', attempts: 1 });
    expect(row.lastError).toContain('SMTP connection refused');
    expect(await deliverNotification(confirmation.id)).toBe('sent');

    const [hostNote] = (await notificationsFor(interviewId)).filter((n) => n.type === 'host_booking_notification');
    outbox.failNext(1);
    await expect(deliverNotification(hostNote.id, { finalAttempt: true })).rejects.toThrow();
    [row] = await db.select().from(notifications).where(eq(notifications.id, hostNote.id));
    expect(row.status).toBe('failed');
  });

  it('releases confirmations whose integration sync never ran (sweeper safety net)', async () => {
    const w = await world();
    const { interviewId } = await book(w.host, w.eventType, upcomingWeekday(TZ, '10:00'));
    // Simulate a crash between booking and the first sync: confirmations still waiting.
    await db.update(notifications).set({ status: 'pending', createdAt: new Date(Date.now() - 10 * 60_000) }).where(eq(notifications.waitForSync, true));
    const result = await handleNotificationSweeper();
    expect(result.released).toBe(2); // candidate confirmation + host notice
    const confirmations = (await notificationsFor(interviewId)).filter((n) => n.waitForSync);
    expect(confirmations.every((n) => n.status === 'queued')).toBe(true);
  });
});

describe('organisation email templates', () => {
  it('applies custom subject and intro copy with placeholders, escaping any HTML', async () => {
    const w = await world();
    await signIn(w.admin);
    const res = await call(templateRoute, {
      method: 'PUT',
      path: '/x',
      params: { type: 'booking_confirmation' },
      body: { subject: 'You are booked, {{candidate_first_name}} — {{organization_name}}', intro: 'Hi {{candidate_name}}! <script>alert(1)</script>', enabled: true },
    });
    expect(res.status).toBe(200);
    signOut();

    const { email } = await book(w.host, w.eventType, upcomingWeekday(TZ, '10:00'), undefined, 'Riley <b>Carter</b>');
    await deliverDueNotifications();
    const [mail] = outbox.to(email);
    expect(mail.subject).toBe('You are booked, Riley — Northwind Labs');
    expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('Riley &lt;b&gt;Carter&lt;/b&gt;');
    expect(mail.html).not.toContain('<b>Carter</b>');
  });

  it('skips disabled notification types but never candidate cancellations', async () => {
    const w = await world();
    await signIn(w.admin);
    await call(templateRoute, { method: 'PUT', path: '/x', params: { type: 'host_booking_notification' }, body: { enabled: false } });
    await call(templateRoute, { method: 'PUT', path: '/x', params: { type: 'cancellation' }, body: { enabled: false } });
    signOut();
    const { email, interviewId } = await book(w.host, w.eventType, upcomingWeekday(TZ, '10:00'));
    await deliverDueNotifications();
    expect(outbox.to(w.host.email)).toHaveLength(0);
    const hostNote = (await notificationsFor(interviewId)).find((n) => n.type === 'host_booking_notification')!;
    expect(hostNote).toMatchObject({ status: 'skipped', lastError: 'Disabled by organization' });

    await cancelInterview({ interviewId, reason: 'Role closed', actor: { type: 'user', userId: w.admin.id }, actorRole: 'admin', via: 'dashboard', inlineSync: false });
    await deliverDueNotifications();
    expect(outbox.to(email).map((m) => m.subject)).toEqual([expect.stringMatching(/^Confirmed/), expect.stringMatching(/^Cancelled/)]);
  });
});
