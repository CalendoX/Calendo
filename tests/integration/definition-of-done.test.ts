import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { POST as loginRoute } from '@/app/api/auth/login/route';
import { GET as meRoute } from '@/app/api/auth/me/route';
import { POST as acceptInviteRoute } from '@/app/api/auth/accept-invite/route';
import { POST as inviteRoute } from '@/app/api/admin/users/route';
import { GET as listEventTypesRoute, POST as createEventTypeRoute } from '@/app/api/event-types/route';
import { GET as listSchedulesRoute } from '@/app/api/availability/route';
import { PUT as updateScheduleRoute } from '@/app/api/availability/[id]/route';
import { GET as scheduleInfoRoute } from '@/app/api/public/schedule/[username]/[eventSlug]/route';
import { GET as availabilityRoute } from '@/app/api/public/availability/[username]/[eventSlug]/route';
import { POST as bookRoute } from '@/app/api/public/book/[username]/[eventSlug]/route';
import { GET as bookingViewRoute } from '@/app/api/public/bookings/[token]/route';
import { POST as candidateRescheduleRoute } from '@/app/api/public/bookings/reschedule/[token]/route';
import { POST as candidateCancelRoute } from '@/app/api/public/bookings/cancel/[token]/route';
import { GET as listInterviewsRoute } from '@/app/api/interviews/route';
import { GET as calendarEventsRoute } from '@/app/api/calendar/events/route';
import { GET as interviewDetailRoute } from '@/app/api/interviews/[id]/route';
import { db } from '@/server/db/client';
import { calendarEvents, interviews, notifications, users, videoMeetings } from '@/server/db/schema';
import { googleEventIdFor } from '@/server/integrations/google/calendar';
import { deliverNotification } from '@/server/notifications/deliver';
import { deliverDueNotifications, lastAccountEmailUrl } from '../helpers/db';
import { fakeProviders } from '../helpers/fake-providers';
import { addMinutes, createMember, createOrg, signIn, signOut } from '../helpers/fixtures';
import { call } from '../helpers/http';
import { connect } from '../helpers/integrations';
import { outbox } from '../helpers/outbox';

/**
 * The complete workflow from the product specification's Definition of Done, executed through
 * the public HTTP API with Google Calendar and Zoom served by protocol-faithful fakes.
 */
describe('definition of done: end-to-end interview workflow', () => {
  it('runs every step from account creation to reminders', async () => {
    const TZ = 'America/New_York';
    const org = await createOrg({ name: 'Northwind Labs' });
    const admin = await createMember(org, { role: 'admin', name: 'Avery Chen' });

    // 1. Admin creates an interviewer account.
    await signIn(admin);
    expect((await call(inviteRoute, { path: '/x', body: { name: 'Priya Nair', email: 'priya@northwind.test', role: 'interviewer' } })).status).toBe(201);
    signOut();
    const invite = await lastAccountEmailUrl('priya@northwind.test', 'invitation');
    expect(
      (await call(acceptInviteRoute, { path: '/x', body: { token: invite.pathname.split('/').pop(), name: 'Priya Nair', password: 'Interview-Loop-2026', timezone: TZ } })).status,
    ).toBe(200);
    signOut();

    // 2. Interviewer logs in.
    expect((await call(loginRoute, { path: '/x', body: { email: 'priya@northwind.test', password: 'Interview-Loop-2026' } })).status).toBe(200);
    const me = await call(meRoute, { path: '/x' });
    expect(me.body).toMatchObject({ role: 'interviewer', organization: { id: org.id } });
    const [priyaRow] = await db.select().from(users).where(eq(users.id, me.body.user.id));
    signOut();

    // 3–4. Connects Google Calendar and Zoom (real OAuth flow against the fakes).
    expect((await connect('google', priyaRow, org)).callback.location).toContain('connected=google');
    expect((await connect('zoom', priyaRow, org)).callback.location).toContain('connected=zoom');
    await signIn(priyaRow, org);

    // 5–6. Creates a 60-minute "Technical Interview" on Zoom.
    const created = await call(createEventTypeRoute, {
      path: '/x',
      body: { name: 'Technical Interview', durationMinutes: 60, locationType: 'zoom', minimumNoticeMinutes: 60, bufferAfterMinutes: 15 },
    });
    expect(created.status).toBe(201);
    expect(created.body.slug).toBe('technical-interview');

    // 7. Defines working hours: Mon–Thu 09:00–12:00 and 13:00–17:00, Fri 09:00–15:00.
    const schedules = await call(listSchedulesRoute, { path: '/x' });
    const scheduleId = schedules.body.items[0].id;
    const split = [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '17:00' }];
    const saved = await call(updateScheduleRoute, {
      method: 'PUT',
      path: '/x',
      params: { id: scheduleId },
      body: {
        name: 'Working hours',
        timezone: TZ,
        weekly: [1, 2, 3, 4].map((weekday) => ({ weekday, intervals: split })).concat([{ weekday: 5, intervals: [{ start: '09:00', end: '15:00' }] }]),
        overrides: [],
      },
    });
    expect(saved.status).toBe(200);

    // 8. Gets the public scheduling URL.
    const types = await call(listEventTypesRoute, { path: '/x' });
    const publicUrl = new URL(types.body.items[0].publicUrl);
    expect(publicUrl.pathname).toBe(`/schedule/${priyaRow.username}/technical-interview`);
    signOut();

    // 9. Candidate opens the URL without logging in.
    const params = { username: priyaRow.username, eventSlug: 'technical-interview' };
    const page = await call(scheduleInfoRoute, { path: '/x', params });
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ host: { name: 'Priya Nair' }, eventType: { name: 'Technical Interview', durationMinutes: 60, timezone: TZ } });

    // 10–11. Sees available times, with existing Google Calendar events excluded.
    let base = DateTime.now().setZone(TZ).plus({ days: 3 }).startOf('day');
    while (base.weekday > 4) base = base.plus({ days: 1 }); // a Mon–Thu day with the lunch break
    const day = base.toJSDate();
    const at = (hhmm: string) => {
      const [hour, minute] = hhmm.split(':').map(Number);
      return base.set({ hour, minute }).toJSDate();
    };
    fakeProviders.google.setBusy('primary-cal@gmail.test', [{ start: at('10:30'), end: at('11:30') }]);
    const slotsRes = await call(availabilityRoute, { path: `/x?start=${day.toISOString()}&end=${addMinutes(day, 1440).toISOString()}`, params });
    const slots: string[] = slotsRes.body.slots.map((s: { start: string }) => s.start);
    expect(slots).toContain(at('09:00').toISOString()); // ends 10:00, buffer to 10:15 — clear of the 10:30 event
    expect(slots).not.toContain(at('09:30').toISOString()); // its 15-minute after-buffer would overlap 10:30
    expect(slots).not.toContain(at('11:00').toISOString()); // Google busy
    expect(slots).not.toContain(at('11:30').toISOString()); // would run into the 12:00–13:00 break
    expect(slots).toContain(at('13:00').toISOString());

    // 12–15. Selects a time, enters details, confirms; the server re-validates.
    const booked = await call(bookRoute, {
      path: '/x',
      params,
      body: { start: at('13:00').toISOString(), name: 'Riley Carter', email: 'riley@candidate.test', timezone: 'Europe/London', answers: {} },
      origin: false,
    });
    expect(booked.status).toBe(201);

    // 16–18. Interview, Zoom meeting and Google Calendar event all exist.
    const [interview] = await db.select().from(interviews);
    expect(interview.startAt.toISOString()).toBe(at('13:00').toISOString());
    const [meeting] = await db.select().from(videoMeetings);
    expect(meeting.status).toBe('synced');
    const googleEvent = fakeProviders.google.events.get(googleEventIdFor(interview.id))!;
    expect(googleEvent.status).toBe('confirmed');
    expect(googleEvent.location).toBe(meeting.joinUrl);

    // 19. Candidate receives confirmation with the Zoom link.
    await deliverDueNotifications();
    const confirmation = outbox.to('riley@candidate.test')[0];
    expect(confirmation.subject).toMatch(/^Confirmed: Technical Interview with Priya Nair/);
    expect(confirmation.text).toContain(meeting.joinUrl!);
    const view = await call(bookingViewRoute, { path: '/x', params: { token: booked.body.confirmationUrl.split('/').pop() } });
    expect(view.body.location.joinUrl).toBe(meeting.joinUrl);

    // 20–21. Interviewer sees it in the dashboard list and on the calendar.
    await signIn(priyaRow, org);
    const list = await call(listInterviewsRoute, { path: '/api/interviews?view=upcoming' });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ meetingStatus: 'synced', calendarStatus: 'synced', candidate: { name: 'Riley Carter' } });
    const cal = await call(calendarEventsRoute, { path: `/x?start=${day.toISOString()}&end=${addMinutes(day, 1440).toISOString()}` });
    expect(cal.body.items.map((i: { id: string }) => i.id)).toEqual([interview.id]);
    signOut();

    // 22–23. Candidate reschedules; Zoom and Google Calendar follow.
    const links = view.body.links;
    const rescheduleToken = new URL(links.reschedule).pathname.split('/').pop()!;
    const newStart = at('15:00');
    expect(
      (await call(candidateRescheduleRoute, { path: '/x', params: { token: rescheduleToken }, body: { start: newStart.toISOString(), timezone: 'Europe/London' }, origin: false })).status,
    ).toBe(200);
    expect(fakeProviders.zoom.meetings.get(meeting.externalMeetingId!)!.start_time).toBe(newStart.toISOString().replace('.000Z', 'Z'));
    expect(fakeProviders.google.events.get(googleEventIdFor(interview.id))!.start.dateTime).toBe(newStart.toISOString());
    await deliverDueNotifications();
    expect(outbox.to('riley@candidate.test').some((m) => m.subject.startsWith('Rescheduled'))).toBe(true);

    // 27 (before cancelling). Reminders fire automatically when due.
    const due = (await db.select().from(notifications).where(eq(notifications.interviewId, interview.id))).filter(
      (n) => n.type === 'reminder' && n.interviewVersion === 2,
    );
    expect(due.map((n) => n.scheduledFor.getTime()).sort()).toEqual([newStart.getTime() - 1440 * 60_000, newStart.getTime() - 60 * 60_000]);
    expect(await deliverNotification(due[0].id)).toBe('sent');
    expect(outbox.to('riley@candidate.test').some((m) => /reminder/i.test(m.subject))).toBe(true);

    // 24–25. Candidate cancels; Zoom meeting deleted and calendar event cancelled.
    const cancelToken = new URL(links.cancel).pathname.split('/').pop()!;
    expect((await call(candidateCancelRoute, { path: '/x', params: { token: cancelToken }, body: { reason: 'Accepted another offer' }, origin: false })).status).toBe(200);
    expect(fakeProviders.zoom.meetings.has(meeting.externalMeetingId!)).toBe(false);
    expect(fakeProviders.google.events.get(googleEventIdFor(interview.id))!.status).toBe('cancelled');
    const [finalMeeting] = await db.select().from(videoMeetings);
    const [finalEvent] = await db.select().from(calendarEvents);
    expect([finalMeeting.status, finalEvent.status]).toEqual(['cancelled', 'cancelled']);

    // 26. Admin sees and can inspect the whole history.
    await signIn(admin);
    const adminList = await call(listInterviewsRoute, { path: '/api/interviews?view=cancelled&scope=team' });
    expect(adminList.body.items.map((i: { id: string }) => i.id)).toEqual([interview.id]);
    const detail = await call(interviewDetailRoute, { path: '/x', params: { id: interview.id } });
    expect(detail.body.interview).toMatchObject({ status: 'cancelled', cancelReason: 'Accepted another offer', cancelledByType: 'candidate', rescheduleCount: 1 });
    expect(detail.body.reschedules).toHaveLength(1);
  });
});
