import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { GET as listRoute, POST as createRoute } from '@/app/api/interviews/route';
import { GET as detailRoute, PATCH as patchRoute } from '@/app/api/interviews/[id]/route';
import { POST as rescheduleRoute } from '@/app/api/interviews/[id]/reschedule/route';
import { POST as cancelRoute } from '@/app/api/interviews/[id]/cancel/route';
import { POST as candidateRescheduleRoute } from '@/app/api/public/bookings/reschedule/[token]/route';
import { GET as candidateRescheduleSlotsRoute } from '@/app/api/public/bookings/reschedule/[token]/availability/route';
import { POST as candidateCancelRoute } from '@/app/api/public/bookings/cancel/[token]/route';
import { db, PG_ERRORS, pgErrorCode } from '@/server/db/client';
import { auditLogs, bookingTokens, candidates, interviewReschedules, interviews } from '@/server/db/schema';
import { handleInterviewsComplete } from '@/server/jobs/handlers';
import { bookingLinksFor } from '@/server/scheduling/booking-tokens';
import { deliverDueNotifications, notificationsFor } from '../helpers/db';
import { addMinutes, createEventType, createMember, createOrg, signIn, signOut, upcomingWeekday, type EventType, type Org, type User } from '../helpers/fixtures';
import { call } from '../helpers/http';
import { outbox } from '../helpers/outbox';

const TZ = 'America/New_York';

interface World {
  org: Org;
  recruiter: User;
  host: User;
  eventType: EventType;
}

async function world(settings = {}): Promise<World> {
  const org = await createOrg({ settings });
  const recruiter = await createMember(org, { role: 'recruiter', name: 'Jordan Rivera' });
  const host = await createMember(org, { role: 'interviewer', name: 'Priya Nair', timezone: TZ });
  const eventType = await createEventType(org, host, { name: 'Technical Interview', bufferAfterMinutes: 15 });
  return { org, recruiter, host, eventType };
}

async function scheduleFor(w: World, start: Date, as: User = w.recruiter, extra: Record<string, unknown> = {}) {
  await signIn(as);
  const res = await call(createRoute, {
    path: '/api/interviews',
    body: {
      eventTypeId: w.eventType.id,
      start: start.toISOString(),
      candidate: { name: 'Morgan Lee', email: `morgan-${randomUUID().slice(0, 6)}@candidate.test`, timezone: 'Asia/Tokyo' },
      ...extra,
    },
  });
  signOut();
  return res;
}

async function tokensFor(interviewId: string) {
  const links = await bookingLinksFor(interviewId);
  return {
    view: links.view!.split('/').pop()!,
    reschedule: links.reschedule!.split('/').pop()!,
    cancel: links.cancel!.split('/').pop()!,
  };
}

describe('creating interviews from the dashboard', () => {
  it('lets a recruiter schedule on behalf of a candidate', async () => {
    const w = await world();
    const start = upcomingWeekday(TZ, '10:00');
    const res = await scheduleFor(w, start);
    expect(res.status).toBe(201);
    const [row] = await db.select().from(interviews).where(eq(interviews.id, res.body.interviewId));
    expect(row).toMatchObject({ source: 'dashboard', status: 'scheduled', hostUserId: w.host.id, candidateTimezone: 'Asia/Tokyo' });
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.resourceId, row.id));
    expect(audit).toMatchObject({ action: 'interview.created', actorType: 'user', actorUserId: w.recruiter.id });
  });

  it('can override working hours when explicitly asked, but never conflicts', async () => {
    const w = await world();
    const evening = upcomingWeekday(TZ, '19:00');
    expect((await scheduleFor(w, evening)).status).toBe(409);
    expect((await scheduleFor(w, evening, w.recruiter, { ignoreWorkingHours: true })).status).toBe(201);
    const clash = await scheduleFor(w, addMinutes(evening, 30), w.recruiter, { ignoreWorkingHours: true });
    expect(clash.status).toBe(409);
    expect(clash.body.error.details.reason).toBe('interview_conflict');
  });
});

describe('rescheduling', () => {
  it('moves the interview, keeps the full history, and re-notifies the candidate', async () => {
    const w = await world();
    const original = upcomingWeekday(TZ, '10:00');
    const { body } = await scheduleFor(w, original);
    const id = body.interviewId as string;
    await deliverDueNotifications();
    const oldReminders = (await notificationsFor(id)).filter((n) => n.type === 'reminder');
    expect(oldReminders).toHaveLength(2);

    const moved = upcomingWeekday(TZ, '14:00', 4);
    await signIn(w.host);
    const res = await call(rescheduleRoute, { path: '/x', params: { id }, body: { start: moved.toISOString(), reason: 'Interviewer travelling' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'rescheduled', startAt: moved.toISOString(), endAt: addMinutes(moved, 60).toISOString() });

    const [row] = await db.select().from(interviews).where(eq(interviews.id, id));
    expect(row).toMatchObject({ version: 2, rescheduleCount: 1, status: 'rescheduled' });

    // The original time is preserved in an immutable history row and the audit log.
    const history = await db.select().from(interviewReschedules).where(eq(interviewReschedules.interviewId, id));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ actorType: 'user', actorUserId: w.host.id, reason: 'Interviewer travelling' });
    expect(history[0].previousStartAt.toISOString()).toBe(original.toISOString());
    expect(history[0].newStartAt.toISOString()).toBe(moved.toISOString());
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.resourceId, id));
    expect(audit.map((a) => a.action)).toContain('interview.rescheduled');

    // Detail API exposes the history for the UI.
    const detail = await call(detailRoute, { path: '/x', params: { id } });
    expect(detail.status).toBe(200);
    expect(detail.body.reschedules).toHaveLength(1);

    // Candidate gets a reschedule email; reminders for the old time are dropped, new ones planned.
    await deliverDueNotifications();
    const candidateEmail = detail.body.candidate.email;
    const mails = outbox.to(candidateEmail);
    expect(mails.map((m) => m.subject)).toEqual([expect.stringMatching(/^Confirmed/), expect.stringMatching(/^Rescheduled/)]);
    expect(mails[1].icalEvent?.content).toContain('SEQUENCE:2');

    const all = await notificationsFor(id);
    const reminders = all.filter((n) => n.type === 'reminder');
    expect(reminders.filter((n) => n.interviewVersion === 2)).toHaveLength(2);
    // Old-version reminders are skipped at delivery time even if their jobs fire.
    const { deliverNotification } = await import('@/server/notifications/deliver');
    for (const r of oldReminders) expect(await deliverNotification(r.id)).toBe('skipped');
  });

  it('refuses to move into a conflict (including buffers) and leaves the interview untouched', async () => {
    const w = await world();
    const a = await scheduleFor(w, upcomingWeekday(TZ, '10:00'));
    const b = await scheduleFor(w, upcomingWeekday(TZ, '13:00'));
    await signIn(w.recruiter);
    // 11:00 is inside interview A's 15-minute after-buffer (A ends 11:00 → free from 11:15).
    const res = await call(rescheduleRoute, { path: '/x', params: { id: b.body.interviewId }, body: { start: upcomingWeekday(TZ, '11:00').toISOString() } });
    expect(res.status).toBe(409);
    const [row] = await db.select().from(interviews).where(eq(interviews.id, b.body.interviewId));
    expect(row).toMatchObject({ version: 1, status: 'scheduled' });
    expect(row.startAt.toISOString()).toBe(upcomingWeekday(TZ, '13:00').toISOString());
    expect(a.status).toBe(201);
  });

  it('lets the candidate reschedule with their token, offering only valid slots', async () => {
    const w = await world();
    const start = upcomingWeekday(TZ, '10:00');
    const { body } = await scheduleFor(w, start);
    const t = await tokensFor(body.interviewId);

    const from = upcomingWeekday(TZ, '00:00');
    const slotsRes = await call(candidateRescheduleSlotsRoute, {
      path: `/x?start=${from.toISOString()}&end=${addMinutes(from, 1440).toISOString()}`,
      params: { token: t.reschedule },
    });
    expect(slotsRes.status).toBe(200);
    const starts = (slotsRes.body.slots as { start: string }[]).map((s) => s.start);
    // The current time is listed (the picker shows it disabled as "current") because the interview
    // never conflicts with itself — but choosing it is rejected by the server.
    expect(starts).toContain(start.toISOString());
    expect(starts).toContain(upcomingWeekday(TZ, '15:00').toISOString());
    const same = await call(candidateRescheduleRoute, {
      path: '/x',
      params: { token: t.reschedule },
      body: { start: start.toISOString(), timezone: 'Europe/Paris' },
      origin: false,
    });
    expect(same.status).toBe(400);
    expect(same.body.error.code).toBe('SAME_TIME');

    const res = await call(candidateRescheduleRoute, {
      path: '/x',
      params: { token: t.reschedule },
      body: { start: upcomingWeekday(TZ, '15:00').toISOString(), timezone: 'Europe/Paris' },
      origin: false,
    });
    expect(res.status).toBe(200);
    // The confirmation page link stays the same.
    expect(res.body.confirmationUrl).toBe(`/booking/${t.view}`);
    const [row] = await db.select().from(interviews).where(eq(interviews.id, body.interviewId));
    expect(row.candidateTimezone).toBe('Europe/Paris');
    const [history] = await db.select().from(interviewReschedules).where(eq(interviewReschedules.interviewId, row.id));
    expect(history.actorType).toBe('candidate');
    // Token expiry follows the new start time.
    const [rt] = await db.select().from(bookingTokens).where(eq(bookingTokens.tokenHash, (await import('@/server/security/crypto')).hashToken(t.reschedule)));
    expect(rt.expiresAt.toISOString()).toBe(upcomingWeekday(TZ, '15:00').toISOString());
  });

  it('honours the organisation policy for candidate self-service', async () => {
    const w = await world({ candidateCanReschedule: false });
    const { body } = await scheduleFor(w, upcomingWeekday(TZ, '10:00'));
    const t = await tokensFor(body.interviewId);
    const res = await call(candidateRescheduleRoute, {
      path: '/x',
      params: { token: t.reschedule },
      body: { start: upcomingWeekday(TZ, '15:00').toISOString(), timezone: TZ },
      origin: false,
    });
    expect(res.status).toBe(403);
  });
});

describe('cancellation', () => {
  it('cancels with a reason, revokes candidate links, and notifies the candidate', async () => {
    const w = await world();
    const { body } = await scheduleFor(w, upcomingWeekday(TZ, '10:00'));
    const id = body.interviewId as string;
    const t = await tokensFor(id);
    await deliverDueNotifications();
    outbox.clear();

    await signIn(w.recruiter);
    const res = await call(cancelRoute, { path: '/x', params: { id }, body: { reason: 'Position filled' } });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(interviews).where(eq(interviews.id, id));
    expect(row).toMatchObject({ status: 'cancelled', cancelReason: 'Position filled', cancelledByType: 'user', cancelledByUserId: w.recruiter.id, version: 2 });

    // Reminders are withdrawn; cancellation emails go out.
    const pending = (await notificationsFor(id)).filter((n) => n.type === 'reminder');
    expect(pending.every((n) => n.status === 'skipped')).toBe(true);
    await deliverDueNotifications();
    const [candidateRow] = await db.select().from(candidates).where(eq(candidates.id, row.candidateId));
    const [candidateMail] = outbox.to(candidateRow.email);
    expect(candidateMail.subject).toMatch(/^Cancelled: Technical Interview/);
    expect(candidateMail?.text).toContain('Position filled');
    expect(candidateMail?.icalEvent?.method).toBe('CANCEL');
    expect(outbox.to(w.host.email)[0].subject).toMatch(/^Cancelled:/);

    // Reschedule/cancel links are revoked; the view link still shows the cancelled booking.
    const again = await call(candidateCancelRoute, { path: '/x', params: { token: t.cancel }, body: {}, origin: false });
    expect(again.status).toBe(410);
    const resched = await call(candidateRescheduleRoute, {
      path: '/x',
      params: { token: t.reschedule },
      body: { start: upcomingWeekday(TZ, '15:00').toISOString(), timezone: TZ },
      origin: false,
    });
    expect(resched.status).toBe(410);

    // Double cancel is rejected; the slot is free again.
    expect((await call(cancelRoute, { path: '/x', params: { id }, body: {} })).status).toBe(409);
    expect((await scheduleFor(w, upcomingWeekday(TZ, '10:00'))).status).toBe(201);

    const audit = await db.select().from(auditLogs).where(eq(auditLogs.resourceId, id));
    expect(audit.find((a) => a.action === 'interview.cancelled')?.metadata).toMatchObject({ reason: 'Position filled', via: 'dashboard' });
  });

  it('lets the candidate cancel via token until the cut-off before the start', async () => {
    const w = await world();
    const { body } = await scheduleFor(w, upcomingWeekday(TZ, '10:00'));
    const t = await tokensFor(body.interviewId);
    const res = await call(candidateCancelRoute, { path: '/x', params: { token: t.cancel }, body: { reason: 'Accepted another offer' }, origin: false });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(interviews).where(eq(interviews.id, body.interviewId));
    expect(row).toMatchObject({ status: 'cancelled', cancelledByType: 'candidate', cancelReason: 'Accepted another offer' });

    // Inside the 60-minute cut-off the candidate must contact the recruiter instead.
    const late = await scheduleFor(w, upcomingWeekday(TZ, '14:00'));
    const lt = await tokensFor(late.body.interviewId);
    const soon = new Date(Date.now() + 30 * 60_000);
    await db.update(interviews).set({ startAt: soon, endAt: addMinutes(soon, 60) }).where(eq(interviews.id, late.body.interviewId));
    const tooLate = await call(candidateCancelRoute, { path: '/x', params: { token: lt.cancel }, body: {}, origin: false });
    expect(tooLate.status).toBe(410);
    expect(tooLate.body.error.code).toBe('TOO_LATE_TO_CHANGE');
  });

  it('respects an organisation that disables candidate cancellation', async () => {
    const w = await world({ candidateCanCancel: false });
    const { body } = await scheduleFor(w, upcomingWeekday(TZ, '10:00'));
    const t = await tokensFor(body.interviewId);
    const res = await call(candidateCancelRoute, { path: '/x', params: { token: t.cancel }, body: {}, origin: false });
    expect(res.status).toBe(403);
  });
});

describe('status changes', () => {
  it('marks interviews completed or no-show only after they start', async () => {
    const w = await world();
    const { body } = await scheduleFor(w, upcomingWeekday(TZ, '10:00'));
    const id = body.interviewId as string;
    await signIn(w.host);
    const early = await call(patchRoute, { method: 'PATCH', path: '/x', params: { id }, body: { status: 'no_show' } });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('NOT_STARTED');

    const past = new Date(Date.now() - 2 * 60 * 60_000);
    await db.update(interviews).set({ startAt: past, endAt: addMinutes(past, 60) }).where(eq(interviews.id, id));
    const noShow = await call(patchRoute, { method: 'PATCH', path: '/x', params: { id }, body: { status: 'no_show' } });
    expect(noShow.status).toBe(200);
    expect(noShow.body.status).toBe('no_show');
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.resourceId, id));
    expect(audit.find((a) => a.action === 'interview.status_changed')?.metadata).toEqual({ from: 'scheduled', to: 'no_show' });
  });

  it('never lets a cancelled interview be marked completed', async () => {
    const w = await world();
    const { body } = await scheduleFor(w, upcomingWeekday(TZ, '10:00'));
    await signIn(w.host);
    await call(cancelRoute, { path: '/x', params: { id: body.interviewId }, body: {} });
    const res = await call(patchRoute, { method: 'PATCH', path: '/x', params: { id: body.interviewId }, body: { status: 'completed' } });
    expect(res.status).toBe(409);
  });

  it('the completion job marks finished interviews completed and leaves others alone', async () => {
    const w = await world();
    const done = await scheduleFor(w, upcomingWeekday(TZ, '10:00'));
    const upcoming = await scheduleFor(w, upcomingWeekday(TZ, '14:00'));
    const past = new Date(Date.now() - 3 * 60 * 60_000);
    await db.update(interviews).set({ startAt: past, endAt: addMinutes(past, 60) }).where(eq(interviews.id, done.body.interviewId));
    expect(await handleInterviewsComplete()).toEqual({ completed: 1 });
    const rows = await db.select({ id: interviews.id, status: interviews.status }).from(interviews);
    expect(rows.find((r) => r.id === done.body.interviewId)?.status).toBe('completed');
    expect(rows.find((r) => r.id === upcoming.body.interviewId)?.status).toBe('scheduled');
  });
});

describe('listing and filtering', () => {
  it('filters by view, status, interviewer and candidate search', async () => {
    const w = await world();
    const other = await createMember(w.org, { role: 'interviewer', name: 'Marcus Webb' });
    const otherType = await createEventType(w.org, other, { name: 'System Design', slug: 'system-design' });
    const a = await scheduleFor(w, upcomingWeekday(TZ, '10:00'));
    await scheduleFor({ ...w, host: other, eventType: otherType }, upcomingWeekday(TZ, '11:00'));
    await signIn(w.recruiter);
    await call(cancelRoute, { path: '/x', params: { id: a.body.interviewId }, body: {} });

    const all = await call(listRoute, { path: '/api/interviews?view=all&scope=team' });
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(2);
    const cancelled = await call(listRoute, { path: '/api/interviews?view=cancelled&scope=team' });
    expect(cancelled.body.items.map((i: { id: string }) => i.id)).toEqual([a.body.interviewId]);
    const upcoming = await call(listRoute, { path: '/api/interviews?view=upcoming&scope=team' });
    expect(upcoming.body.items).toHaveLength(1);
    const byInterviewer = await call(listRoute, { path: `/api/interviews?view=all&scope=team&interviewerId=${other.id}` });
    expect(byInterviewer.body.items).toHaveLength(1);
    const search = await call(listRoute, { path: '/api/interviews?view=all&scope=team&q=morgan' });
    expect(search.body.total).toBe(2);
    const none = await call(listRoute, { path: '/api/interviews?view=all&scope=team&q=nobody-matches' });
    expect(none.body.total).toBe(0);
  });
});

describe('database safety net', () => {
  it('the exclusion constraint rejects overlapping active interviews even if application checks are bypassed', async () => {
    const w = await world();
    const { body } = await scheduleFor(w, upcomingWeekday(TZ, '10:00'));
    const [row] = await db.select().from(interviews).where(eq(interviews.id, body.interviewId));
    const { id: _id, createdAt: _c, updatedAt: _u, idempotencyKey: _k, ...copy } = row;
    const err = await db
      .insert(interviews)
      .values({ ...copy, startAt: addMinutes(row.startAt, 30), endAt: addMinutes(row.endAt, 30) })
      .then(() => null, (e: unknown) => e);
    expect(pgErrorCode(err)).toBe(PG_ERRORS.EXCLUSION_VIOLATION);

    // Cancelled interviews do not block the time.
    await db.update(interviews).set({ status: 'cancelled' }).where(eq(interviews.id, row.id));
    await expect(db.insert(interviews).values({ ...copy, startAt: row.startAt, endAt: row.endAt }).returning()).resolves.toHaveLength(1);
  });
});
