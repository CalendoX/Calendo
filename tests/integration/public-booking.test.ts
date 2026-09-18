import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { POST as bookRoute } from '@/app/api/public/book/[username]/[eventSlug]/route';
import { GET as availabilityRoute } from '@/app/api/public/availability/[username]/[eventSlug]/route';
import { GET as scheduleRoute } from '@/app/api/public/schedule/[username]/[eventSlug]/route';
import { GET as bookingViewRoute } from '@/app/api/public/bookings/[token]/route';
import { POST as createLinkRoute } from '@/app/api/event-types/[id]/links/route';
import { DELETE as revokeLinkRoute } from '@/app/api/scheduling-links/[id]/route';
import { db } from '@/server/db/client';
import { auditLogs, bookingTokens, candidates, interviews, memberships, schedulingLinks } from '@/server/db/schema';
import { deliverDueNotifications, jobs, notificationsFor } from '../helpers/db';
import { addMinutes, createEventType, createMember, createOrg, signIn, signOut, upcomingWeekday, type EventType, type User } from '../helpers/fixtures';
import { call } from '../helpers/http';
import { outbox } from '../helpers/outbox';

const HOST_TZ = 'America/New_York';

async function setup(overrides: Parameters<typeof createEventType>[2] = {}) {
  const org = await createOrg({ name: 'Northwind Labs' });
  const host = await createMember(org, { role: 'interviewer', name: 'Priya Nair', timezone: HOST_TZ });
  const eventType = await createEventType(org, host, overrides);
  return { org, host, eventType };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return { name: 'Riley Carter', email: `riley-${randomUUID().slice(0, 8)}@candidate.test`, timezone: 'Europe/London', answers: {}, ...overrides };
}

function book(host: User, eventType: EventType, start: Date, body: Record<string, unknown> = {}, ip = `10.1.0.${Math.floor(Math.random() * 250)}`) {
  return call(bookRoute, {
    path: `/api/public/book/${host.username}/${eventType.slug}`,
    params: { username: host.username, eventSlug: eventType.slug },
    body: { start: start.toISOString(), ...candidate(), ...body },
    origin: false,
    ip,
  });
}

async function availableStarts(host: User, eventType: EventType, from: Date, days = 1, link?: string) {
  const to = addMinutes(from, days * 24 * 60);
  const qs = new URLSearchParams({ start: from.toISOString(), end: to.toISOString(), ...(link ? { link } : {}) });
  const res = await call(availabilityRoute, {
    path: `/api/public/availability/${host.username}/${eventType.slug}?${qs}`,
    params: { username: host.username, eventSlug: eventType.slug },
  });
  expect(res.status).toBe(200);
  return (res.body.slots as { start: string }[]).map((s) => s.start);
}

describe('public booking: happy path', () => {
  it('books an available slot, records everything, and emails both parties', async () => {
    const { host, eventType, org } = await setup({ name: 'Technical Interview', durationMinutes: 60, locationType: 'phone', locationDetails: '+1 555 0100' });
    const start = upcomingWeekday(HOST_TZ, '10:00');
    const email = `riley-${randomUUID().slice(0, 6)}@candidate.test`;

    const res = await book(host, eventType, start, { email, phone: '+44 20 7946 0000' });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.confirmationUrl).toMatch(/^\/booking\/[A-Za-z0-9_-]{40,}$/);

    const [interview] = await db.select().from(interviews).where(eq(interviews.eventTypeId, eventType.id));
    expect(interview).toMatchObject({
      organizationId: org.id,
      hostUserId: host.id,
      status: 'scheduled',
      timezone: HOST_TZ,
      candidateTimezone: 'Europe/London',
      source: 'public_page',
      locationType: 'phone',
    });
    // Stored as UTC instants; the end honours the event duration.
    expect(interview.startAt.toISOString()).toBe(start.toISOString());
    expect(interview.endAt.getTime() - interview.startAt.getTime()).toBe(60 * 60_000);

    const [cand] = await db.select().from(candidates).where(eq(candidates.id, interview.candidateId));
    expect(cand).toMatchObject({ email, name: 'Riley Carter', phone: '+44 20 7946 0000' });

    // Three capability tokens; only hashes are used for lookup and the raw token is not stored.
    const tokens = await db.select().from(bookingTokens).where(eq(bookingTokens.interviewId, interview.id));
    expect(tokens.map((t) => t.purpose).sort()).toEqual(['cancel', 'reschedule', 'view']);
    const rawView = res.body.confirmationUrl.split('/').pop();
    expect(tokens.every((t) => t.tokenHash !== rawView && !t.tokenEncrypted.includes(rawView))).toBe(true);

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.resourceId, interview.id));
    expect(audit).toMatchObject({ action: 'interview.created', actorType: 'candidate', resourceType: 'interview' });

    // Confirmation + host notice go out after the (inline) integration sync; reminders are scheduled.
    const planned = await notificationsFor(interview.id);
    expect(planned.map((n) => n.type).sort()).toEqual(['booking_confirmation', 'host_booking_notification', 'reminder', 'reminder']);
    const reminderTimes = planned.filter((n) => n.type === 'reminder').map((n) => n.scheduledFor.getTime());
    expect(reminderTimes.sort()).toEqual([start.getTime() - 1440 * 60_000, start.getTime() - 60 * 60_000]);
    const reminderJobs = (await jobs<{ notificationId: string }>('notification-deliver')).filter((j) => j.startAfter.getTime() > Date.now() + 60_000);
    expect(reminderJobs).toHaveLength(2);

    await deliverDueNotifications();
    const [confirmation] = outbox.to(email);
    expect(confirmation.subject).toContain('Confirmed: Technical Interview with Priya Nair');
    // Rendered in the candidate's zone (the same instant as 10:00 New York), not the interviewer's.
    const londonTime = DateTime.fromJSDate(start, { zone: 'Europe/London' }).toFormat('h:mm a');
    expect(confirmation.text).toContain(`${londonTime} – `);
    expect(confirmation.text).toContain('Europe/London');
    expect(confirmation.text).toMatch(/Reschedule: http:\/\/localhost:3000\/booking\/reschedule\/[A-Za-z0-9_-]+/);
    expect(confirmation.text).toMatch(/Cancel: http:\/\/localhost:3000\/booking\/cancel\/[A-Za-z0-9_-]+/);
    expect(confirmation.icalEvent?.method).toBe('REQUEST');
    expect(confirmation.icalEvent?.content).toContain(`DTSTART:${start.toISOString().replace(/[-:]/g, '').replace('.000', '')}`);
    expect(outbox.to(host.email)[0].subject).toContain('New interview: Riley Carter');
  });

  it('shows the event and removes a booked slot from public availability', async () => {
    const { host, eventType } = await setup();
    const info = await call(scheduleRoute, { path: '/x', params: { username: host.username, eventSlug: eventType.slug } });
    expect(info.status).toBe(200);
    expect(info.body.eventType).toMatchObject({ name: 'Technical Interview', durationMinutes: 60, timezone: HOST_TZ });
    expect(JSON.stringify(info.body)).not.toContain(host.email);

    const start = upcomingWeekday(HOST_TZ, '13:00');
    const dayStart = upcomingWeekday(HOST_TZ, '00:00');
    const before = await availableStarts(host, eventType, dayStart);
    expect(before).toContain(start.toISOString());
    // 09:00–17:00 with a 60-minute event on a 30-minute grid → 09:00 … 16:00 = 15 starts.
    expect(before).toHaveLength(15);

    expect((await book(host, eventType, start)).status).toBe(201);
    const after = await availableStarts(host, eventType, dayStart);
    expect(after).not.toContain(start.toISOString());
    // The overlapping half-hour neighbours are gone too.
    expect(after).not.toContain(addMinutes(start, -30).toISOString());
    expect(after).not.toContain(addMinutes(start, 30).toISOString());
    expect(after).toContain(addMinutes(start, 60).toISOString());
  });
});

describe('public booking: invalid events', () => {
  it('returns 404 for unknown users and event slugs', async () => {
    const { host, eventType } = await setup();
    const start = upcomingWeekday(HOST_TZ, '10:00');
    const unknownUser = await call(bookRoute, {
      path: '/x',
      params: { username: 'nobody-here', eventSlug: eventType.slug },
      body: { start: start.toISOString(), ...candidate() },
      origin: false,
    });
    expect(unknownUser.status).toBe(404);
    const unknownSlug = await call(bookRoute, {
      path: '/x',
      params: { username: host.username, eventSlug: 'no-such-event' },
      body: { start: start.toISOString(), ...candidate() },
      origin: false,
    });
    expect(unknownSlug.status).toBe(404);
    expect(unknownSlug.body.error.message).toBe('This scheduling page is not available.');
  });

  it('refuses inactive event types, link-only event types and deactivated interviewers', async () => {
    const start = upcomingWeekday(HOST_TZ, '10:00');
    const inactive = await setup({ isActive: false });
    expect((await book(inactive.host, inactive.eventType, start)).status).toBe(404);

    const linkOnly = await setup({ visibility: 'link_only' });
    expect((await book(linkOnly.host, linkOnly.eventType, start)).status).toBe(404);

    const gone = await setup();
    await db.update(memberships).set({ status: 'deactivated' }).where(eq(memberships.userId, gone.host.id));
    expect((await book(gone.host, gone.eventType, start)).status).toBe(404);
    expect(await db.select().from(interviews)).toHaveLength(0);
  });

  it('validates candidate details and required custom questions', async () => {
    const { host, eventType } = await setup({
      questions: [{ id: 'stack', label: 'Preferred language?', type: 'single_select', required: true, options: ['TypeScript', 'Go'] }],
      fieldConfig: { phone: 'required', company: 'hidden', linkedinUrl: 'optional', resumeUrl: 'optional' },
    });
    const start = upcomingWeekday(HOST_TZ, '10:00');
    const missing = await book(host, eventType, start);
    expect(missing.status).toBe(422);
    expect(Object.keys(missing.body.error.details)).toEqual(expect.arrayContaining(['phone', 'answers.stack']));

    const badOption = await book(host, eventType, start, { phone: '+1 555 0100', answers: { stack: 'COBOL' } });
    expect(badOption.status).toBe(422);

    const badEmail = await book(host, eventType, start, { email: 'not-an-email', phone: '+1 555 0100', answers: { stack: 'Go' } });
    expect(badEmail.status).toBe(422);

    const ok = await book(host, eventType, start, { phone: '+1 555 0100', answers: { stack: 'Go' } });
    expect(ok.status).toBe(201);
    const [row] = await db.select().from(interviews);
    expect(row.responses).toEqual([{ questionId: 'stack', label: 'Preferred language?', answer: 'Go' }]);
  });
});

describe('public booking: slot validation happens on the server', () => {
  it('rejects a slot that is already booked', async () => {
    const { host, eventType } = await setup();
    const start = upcomingWeekday(HOST_TZ, '10:00');
    expect((await book(host, eventType, start)).status).toBe(201);
    const second = await book(host, eventType, start);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: 'SLOT_UNAVAILABLE', details: { reason: 'interview_conflict' } });
    // A partially overlapping start is rejected as well.
    expect((await book(host, eventType, addMinutes(start, 30))).status).toBe(409);
  });

  it('allows exactly one booking when many candidates race for the same slot', async () => {
    const { host, eventType } = await setup();
    const start = upcomingWeekday(HOST_TZ, '11:00');
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => book(host, eventType, start, {}, `10.9.0.${i + 1}`)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
    expect(await db.select().from(interviews)).toHaveLength(1);
  });

  it('prevents overlapping bookings across different event types of the same interviewer', async () => {
    const { org, host, eventType } = await setup();
    const other = await createEventType(org, host, { name: 'Culture chat', slug: 'culture-chat', durationMinutes: 30 });
    const start = upcomingWeekday(HOST_TZ, '14:00');
    expect((await book(host, eventType, start)).status).toBe(201);
    const clash = await book(host, other, addMinutes(start, 30));
    expect(clash.status).toBe(409);
  });

  it('rejects a duplicate booking by the same candidate for the same interview type', async () => {
    const { host, eventType } = await setup();
    const email = 'same.person@candidate.test';
    expect((await book(host, eventType, upcomingWeekday(HOST_TZ, '10:00'), { email })).status).toBe(201);
    const dup = await book(host, eventType, upcomingWeekday(HOST_TZ, '15:00'), { email: 'Same.Person@Candidate.test' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_BOOKING');
  });

  it('returns the original booking when a client retries with the same idempotency key', async () => {
    const { host, eventType } = await setup();
    const start = upcomingWeekday(HOST_TZ, '10:00');
    const body = { email: 'retry@candidate.test', idempotencyKey: 'client-retry-key-123' };
    const first = await book(host, eventType, start, body);
    const retry = await book(host, eventType, start, body);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ created: false, confirmationUrl: first.body.confirmationUrl });
    expect(await db.select().from(interviews)).toHaveLength(1);
  });

  it('accounts for buffers: a 15-minute after-buffer blocks the next start until 11:15', async () => {
    const { host, eventType } = await setup({ durationMinutes: 60, bufferAfterMinutes: 15 });
    const start = upcomingWeekday(HOST_TZ, '10:00');
    expect((await book(host, eventType, start)).status).toBe(201);
    const slots = await availableStarts(host, eventType, upcomingWeekday(HOST_TZ, '00:00'));
    expect(slots).not.toContain(addMinutes(start, 60).toISOString()); // 11:00
    expect(slots).toContain(addMinutes(start, 90).toISOString()); // 11:30 (next grid slot after 11:15)
    // And the slot before must leave room for this event's own buffer... 09:00–10:00 + 15 min overlaps 10:00.
    expect(slots).not.toContain(addMinutes(start, -60).toISOString());
    expect((await book(host, eventType, addMinutes(start, 60))).status).toBe(409);
  });

  it('enforces minimum notice and the maximum booking window', async () => {
    const soon = await setup({ minimumNoticeMinutes: 7 * 24 * 60 });
    const tooSoon = await book(soon.host, soon.eventType, upcomingWeekday(HOST_TZ, '10:00', 2));
    expect(tooSoon.status).toBe(409);
    expect(tooSoon.body.error.details.reason).toBe('too_soon');

    const window = await setup({ maxDaysInFuture: 5, slug: 'short-window' });
    const tooFar = await book(window.host, window.eventType, upcomingWeekday(HOST_TZ, '10:00', 12));
    expect(tooFar.status).toBe(409);
    expect(tooFar.body.error.details.reason).toBe('too_far');
  });

  it('rejects times outside working hours and off the slot grid', async () => {
    const { host, eventType } = await setup();
    const evening = await book(host, eventType, upcomingWeekday(HOST_TZ, '19:00'));
    expect(evening.status).toBe(409);
    expect(evening.body.error.details.reason).toBe('outside_availability');
    const offGrid = await book(host, eventType, upcomingWeekday(HOST_TZ, '10:07'));
    expect(offGrid.body.error.details.reason).toBe('outside_availability');
    const lateStart = await book(host, eventType, upcomingWeekday(HOST_TZ, '16:30')); // would end 17:30
    expect(lateStart.body.error.details.reason).toBe('outside_availability');
  });
});

describe('scheduling links', () => {
  async function createLink(host: User, eventType: EventType, body: Record<string, unknown> = {}) {
    await signIn(host);
    const res = await call(createLinkRoute, { path: '/x', params: { id: eventType.id }, body: { maxUses: 1, expiresInDays: 7, ...body } });
    signOut();
    expect(res.status).toBe(201);
    return { id: res.body.id as string, token: new URL(res.body.url).pathname.split('/').pop()! };
  }

  it('single-use links book link-only events once and then stop working', async () => {
    const { host, eventType } = await setup({ visibility: 'link_only' });
    const link = await createLink(host, eventType);
    const slots = await availableStarts(host, eventType, upcomingWeekday(HOST_TZ, '00:00'), 1, link.token);
    expect(slots.length).toBeGreaterThan(0);

    const first = await book(host, eventType, new Date(slots[0]), { link: link.token });
    expect(first.status).toBe(201);
    const [row] = await db.select().from(interviews);
    expect(row.source).toBe('scheduling_link');

    const reuse = await book(host, eventType, new Date(slots[4]), { link: link.token });
    expect(reuse.status).toBe(410);
    expect(reuse.body.error.code).toBe('LINK_USED');
  });

  it('rejects expired and revoked links', async () => {
    const { host, eventType } = await setup({ visibility: 'link_only' });
    const start = upcomingWeekday(HOST_TZ, '10:00');

    const expired = await createLink(host, eventType);
    await db.update(schedulingLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schedulingLinks.id, expired.id));
    const r1 = await book(host, eventType, start, { link: expired.token });
    expect(r1.status).toBe(410);
    expect(r1.body.error.code).toBe('LINK_EXPIRED');

    const revoked = await createLink(host, eventType);
    await signIn(host);
    expect((await call(revokeLinkRoute, { method: 'DELETE', path: '/x', params: { id: revoked.id } })).status).toBe(200);
    signOut();
    const r2 = await book(host, eventType, start, { link: revoked.token });
    expect(r2.status).toBe(410);
    expect(r2.body.error.code).toBe('LINK_REVOKED');

    const bogus = await book(host, eventType, start, { link: 'x'.repeat(32) });
    expect(bogus.status).toBe(404);
    expect(await db.select().from(interviews)).toHaveLength(0);
  });
});

describe('candidate booking page tokens', () => {
  it('serves the booking to its token holder only, and never by internal id', async () => {
    const { host, eventType } = await setup();
    const res = await book(host, eventType, upcomingWeekday(HOST_TZ, '10:00'));
    const token = res.body.confirmationUrl.split('/').pop();
    const view = await call(bookingViewRoute, { path: '/x', params: { token } });
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ status: 'scheduled', candidate: { name: 'Riley Carter' }, policy: { canReschedule: true, canCancel: true } });

    const [row] = await db.select().from(interviews);
    expect((await call(bookingViewRoute, { path: '/x', params: { token: row.id } })).status).toBe(404);
    expect((await call(bookingViewRoute, { path: '/x', params: { token: token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A') } })).status).toBe(404);

    await db.update(bookingTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(bookingTokens.interviewId, row.id));
    expect((await call(bookingViewRoute, { path: '/x', params: { token } })).status).toBe(410);
  });
});
