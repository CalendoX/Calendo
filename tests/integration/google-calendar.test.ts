import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { POST as connectRoute } from '@/app/api/integrations/[provider]/connect/route';
import { GET as callbackRoute } from '@/app/api/integrations/[provider]/callback/route';
import { POST as disconnectRoute } from '@/app/api/integrations/[provider]/disconnect/route';
import { GET as listIntegrationsRoute } from '@/app/api/integrations/route';
import { PATCH as calendarSelectionRoute } from '@/app/api/integrations/google/calendars/route';
import { POST as bookRoute } from '@/app/api/public/book/[username]/[eventSlug]/route';
import { GET as availabilityRoute } from '@/app/api/public/availability/[username]/[eventSlug]/route';
import { POST as rescheduleRoute } from '@/app/api/interviews/[id]/reschedule/route';
import { POST as cancelRoute } from '@/app/api/interviews/[id]/cancel/route';
import { POST as syncRoute } from '@/app/api/interviews/[id]/sync/route';
import { POST as googleWebhookRoute } from '@/app/api/webhooks/google/route';
import { db } from '@/server/db/client';
import { auditLogs, calendarEvents, calendarWatchChannels, integrationCalendars, integrations, interviews, webhookEvents } from '@/server/db/schema';
import { googleCalendarProvider, googleEventIdFor } from '@/server/integrations/google/calendar';
import { tokenSourceFor } from '@/server/integrations/service';
import { processWebhookEvent } from '@/server/integrations/webhooks';
import { decrypt } from '@/server/security/crypto';
import { jobs } from '../helpers/db';
import { fakeProviders, GOOGLE_FULL_SCOPES } from '../helpers/fake-providers';
import { addMinutes, createEventType, createMember, createOrg, signIn, signOut, upcomingWeekday, type EventType, type User } from '../helpers/fixtures';
import { call } from '../helpers/http';
import { connect, integrationRow } from '../helpers/integrations';

const TZ = 'America/New_York';
const PRIMARY = 'primary-cal@gmail.test';
const HOLIDAYS = 'team-holidays@group.calendar.google.com';
const google = () => fakeProviders.google;

async function world(orgSettings = {}) {
  const org = await createOrg({ settings: orgSettings });
  const host = await createMember(org, { role: 'interviewer', name: 'Priya Nair', timezone: TZ });
  const eventType = await createEventType(org, host, {
    name: 'Technical Interview',
    questions: [{ id: 'focus', label: 'What should we focus on?', type: 'short_text', required: false }],
  });
  return { org, host, eventType };
}

async function connected(orgSettings = {}) {
  const w = await world(orgSettings);
  const { callback } = await connect('google', w.host, w.org);
  expect(callback.status).toBe(303);
  expect(callback.location).toBe('http://localhost:3000/integrations?connected=google');
  return w;
}

function book(host: User, eventType: EventType, start: Date, extra: Record<string, unknown> = {}) {
  return call(bookRoute, {
    path: '/x',
    params: { username: host.username, eventSlug: eventType.slug },
    body: {
      start: start.toISOString(),
      name: 'Riley Carter',
      email: `riley-${randomUUID().slice(0, 6)}@candidate.test`,
      phone: '+1 555 0142',
      timezone: 'Europe/London',
      answers: { focus: 'Distributed systems' },
      ...extra,
    },
    origin: false,
  });
}

async function slotsOn(host: User, eventType: EventType, day: Date) {
  const res = await call(availabilityRoute, {
    path: `/x?start=${day.toISOString()}&end=${addMinutes(day, 1440).toISOString()}`,
    params: { username: host.username, eventSlug: eventType.slug },
  });
  return res;
}

describe('Google OAuth flow', () => {
  it('uses PKCE + state, stores encrypted credentials and discovers calendars', async () => {
    const w = await world();
    const { authorizationUrl, callback } = await connect('google', w.host, w.org);

    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = authorizationUrl.searchParams;
    expect(p.get('client_id')).toBe(process.env.GOOGLE_CLIENT_ID);
    expect(p.get('redirect_uri')).toBe('http://localhost:3000/api/integrations/google/callback');
    expect(p.get('response_type')).toBe('code');
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get('scope')!.split(' ')).toEqual(expect.arrayContaining(['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.readonly']));
    expect(callback.status).toBe(303);

    const row = (await integrationRow(w.host.id, 'google_calendar'))!;
    expect(row).toMatchObject({ status: 'active', externalAccountId: google().account.sub, externalAccountEmail: google().account.email });
    // Tokens are encrypted at rest (AES-GCM, versioned) and decrypt to what Google issued.
    expect(row.accessTokenEncrypted).toMatch(/^v1:/);
    expect(row.refreshTokenEncrypted).toMatch(/^v1:/);
    expect(decrypt(row.accessTokenEncrypted!)).toMatch(/^g-at-/);
    expect(decrypt(row.refreshTokenEncrypted!)).toMatch(/^g-rt-/);
    expect(row.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);

    const cals = await db.select().from(integrationCalendars).where(eq(integrationCalendars.integrationId, row.id));
    expect(cals.map((c) => [c.externalCalendarId, c.checkConflicts, c.isWriteTarget]).sort()).toEqual([
      [PRIMARY, true, true],
      [HOLIDAYS, false, false],
    ].sort());

    // Push notifications are registered for the calendars in use.
    const channels = await db.select().from(calendarWatchChannels).where(eq(calendarWatchChannels.integrationId, row.id));
    expect(channels.map((c) => c.externalCalendarId)).toEqual([PRIMARY]);
    expect([...google().channels.values()][0].address).toBe('https://hooks.slate.test/api/webhooks/google');

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, 'integration.connected'));
    expect(audit.metadata).toMatchObject({ provider: 'google_calendar', accountEmail: google().account.email });

    // The status API never exposes credentials.
    await signIn(w.host);
    const status = await call(listIntegrationsRoute, { path: '/api/integrations' });
    const text = JSON.stringify(status.body);
    expect(text).not.toMatch(/g-at-|g-rt-|v1:/);
    expect(status.body.items.find((i: { provider: string }) => i.provider === 'google_calendar')).toMatchObject({ connected: true, status: 'active' });
  });

  it('rejects forged, replayed and cross-user OAuth states', async () => {
    const w = await world();
    const mallory = await createMember(w.org, { role: 'interviewer' });
    await signIn(w.host);
    const start = await call(connectRoute, { path: '/x', params: { provider: 'google' }, body: {} });
    const grant = google().authorize(start.body.url);
    signOut();

    // Another signed-in user cannot complete Priya's authorization.
    await signIn(mallory);
    const hijack = await call(callbackRoute, { path: `/x?code=${grant.code}&state=${grant.state}`, params: { provider: 'google' } });
    expect(new URL(hijack.location!).searchParams.get('error')).toBe('connect_failed');
    signOut();

    // The state was consumed by that attempt; a replay by the rightful user fails too.
    await signIn(w.host);
    const grant2 = google().authorize(start.body.url);
    const replay = await call(callbackRoute, { path: `/x?code=${grant2.code}&state=${grant.state}`, params: { provider: 'google' } });
    expect(new URL(replay.location!).searchParams.get('error')).toBe('connect_failed');
    const forged = await call(callbackRoute, { path: `/x?code=${grant2.code}&state=forged-state-value`, params: { provider: 'google' } });
    expect(new URL(forged.location!).searchParams.get('error')).toBe('connect_failed');
    const denied = await call(callbackRoute, { path: '/x?error=access_denied', params: { provider: 'google' } });
    expect(new URL(denied.location!).searchParams.get('error')).toBe('access_denied');
    expect(await integrationRow(w.host.id, 'google_calendar')).toBeNull();
    expect(await integrationRow(mallory.id, 'google_calendar')).toBeNull();
  });

  it('refuses a connection without calendar permissions and revokes the token', async () => {
    const w = await world();
    const { callback } = await connect('google', w.host, w.org, { scopes: GOOGLE_FULL_SCOPES.filter((s) => !s.endsWith('calendar.events')) });
    expect(new URL(callback.location!).searchParams.get('error')).toBe('connect_failed');
    expect(await integrationRow(w.host.id, 'google_calendar')).toBeNull();
    expect(google().revoked).toHaveLength(1);
  });

  it('disconnects: stops push channels, revokes at Google and deletes credentials', async () => {
    const w = await connected();
    const row = (await integrationRow(w.host.id, 'google_calendar'))!;
    const refresh = decrypt(row.refreshTokenEncrypted!);
    await signIn(w.host);
    expect((await call(disconnectRoute, { path: '/x', params: { provider: 'google' }, body: {} })).status).toBe(200);
    expect(google().revoked).toContain(refresh);
    expect(google().channels.size).toBe(0);
    expect(await integrationRow(w.host.id, 'google_calendar')).toBeNull();
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.action, 'integration.disconnected'));
    expect(audit).toHaveLength(1);
  });
});

describe('calendar conflict detection', () => {
  it('never offers or books times that are busy in Google Calendar', async () => {
    const w = await connected();
    const day = upcomingWeekday(TZ, '00:00');
    google().setBusy(PRIMARY, [{ start: upcomingWeekday(TZ, '10:00'), end: upcomingWeekday(TZ, '11:00') }]);

    const res = await slotsOn(w.host, w.eventType, day);
    expect(res.status).toBe(200);
    const starts = res.body.slots.map((s: { start: string }) => s.start);
    expect(starts).toContain(upcomingWeekday(TZ, '09:00').toISOString());
    expect(starts).not.toContain(upcomingWeekday(TZ, '09:30').toISOString()); // 09:30–10:30 overlaps
    expect(starts).not.toContain(upcomingWeekday(TZ, '10:00').toISOString());
    expect(starts).not.toContain(upcomingWeekday(TZ, '10:30').toISOString());
    expect(starts).toContain(upcomingWeekday(TZ, '11:00').toISOString());

    const attempt = await book(w.host, w.eventType, upcomingWeekday(TZ, '10:00'));
    expect(attempt.status).toBe(409);
    expect(attempt.body.error.details.reason).toBe('calendar_conflict');
  });

  it('only checks the calendars selected for conflicts', async () => {
    const w = await connected();
    google().setBusy(HOLIDAYS, [{ start: upcomingWeekday(TZ, '09:00'), end: upcomingWeekday(TZ, '17:00') }]);
    const day = upcomingWeekday(TZ, '00:00');
    expect((await slotsOn(w.host, w.eventType, day)).body.slots).toHaveLength(15);

    const row = (await integrationRow(w.host.id, 'google_calendar'))!;
    const cals = await db.select().from(integrationCalendars).where(eq(integrationCalendars.integrationId, row.id));
    const primary = cals.find((c) => c.externalCalendarId === PRIMARY)!;
    const holidays = cals.find((c) => c.externalCalendarId === HOLIDAYS)!;
    await signIn(w.host);
    // A read-only calendar cannot receive interviews…
    const bad = await call(calendarSelectionRoute, { method: 'PATCH', path: '/x', body: { writeCalendarId: holidays.id, conflictCalendarIds: [primary.id] } });
    expect(bad.status).toBe(422);
    // …but can be checked for conflicts.
    const ok = await call(calendarSelectionRoute, { method: 'PATCH', path: '/x', body: { writeCalendarId: primary.id, conflictCalendarIds: [primary.id, holidays.id] } });
    expect(ok.status).toBe(200);
    expect((await slotsOn(w.host, w.eventType, day)).body.slots).toHaveLength(0);
  });

  it('fails closed when Google Calendar cannot be read', async () => {
    const w = await connected();
    const day = upcomingWeekday(TZ, '00:00');
    fakeProviders.failNext({ provider: 'google', method: 'POST', path: /\/freeBusy$/, status: 503, times: 2 });
    const slots = await slotsOn(w.host, w.eventType, day);
    expect(slots.status).toBe(503);
    expect(slots.body.error.code).toBe('CALENDAR_UNAVAILABLE');
    const attempt = await book(w.host, w.eventType, upcomingWeekday(TZ, '10:00'));
    expect(attempt.status).toBe(503);

    // A per-calendar error inside a 200 response is treated the same way.
    google().freeBusyErrors.set(PRIMARY, 'backendError');
    expect((await book(w.host, w.eventType, upcomingWeekday(TZ, '10:00'))).status).toBe(503);
    expect(await db.select().from(interviews)).toHaveLength(0);

    // Once Google recovers, booking works.
    google().freeBusyErrors.clear();
    expect((await book(w.host, w.eventType, upcomingWeekday(TZ, '10:00'))).status).toBe(201);
  });
});

describe('calendar event lifecycle', () => {
  it('creates a detailed event linked to the interview when a candidate books', async () => {
    const w = await connected();
    const start = upcomingWeekday(TZ, '10:00');
    expect((await book(w.host, w.eventType, start, { email: 'riley@candidate.test' })).status).toBe(201);
    const [interview] = await db.select().from(interviews);
    const [row] = await db.select().from(calendarEvents).where(eq(calendarEvents.interviewId, interview.id));
    expect(row).toMatchObject({ status: 'synced', syncedVersion: 1, externalCalendarId: PRIMARY, externalEventId: googleEventIdFor(interview.id) });
    expect(row.htmlLink).toContain(row.externalEventId!);

    const event = google().events.get(row.externalEventId!)!;
    expect(event.summary).toBe('Technical Interview: Riley Carter');
    expect(event.start).toEqual({ dateTime: start.toISOString(), timeZone: TZ });
    expect(event.end).toEqual({ dateTime: addMinutes(start, 60).toISOString(), timeZone: TZ });
    expect(event.extendedProperties?.private?.slateInterviewId).toBe(interview.id);
    for (const expected of ['riley@candidate.test', 'Priya Nair', '+1 555 0142', 'What should we focus on?: Distributed systems', `/interviews/${interview.id}`]) {
      expect(event.description).toContain(expected);
    }
    // By default the candidate is not added as a guest (Slate sends its own emails).
    expect(event.attendees).toEqual([]);
    expect(event.sendUpdates).toBe('none');
  });

  it('adds the candidate as a guest when the organisation enables it', async () => {
    const w = await connected({ addCandidateAsCalendarAttendee: true });
    await book(w.host, w.eventType, upcomingWeekday(TZ, '10:00'), { email: 'guest@candidate.test' });
    const [event] = google().liveEvents();
    expect(event.attendees).toEqual([{ email: 'guest@candidate.test', displayName: 'Riley Carter' }]);
    expect(event.sendUpdates).toBe('all');
  });

  it('updates the same event on reschedule and removes it on cancellation', async () => {
    const w = await connected();
    await book(w.host, w.eventType, upcomingWeekday(TZ, '10:00'));
    const [interview] = await db.select().from(interviews);
    const eventId = googleEventIdFor(interview.id);

    await signIn(w.host);
    const moved = upcomingWeekday(TZ, '15:00', 5);
    expect((await call(rescheduleRoute, { path: '/x', params: { id: interview.id }, body: { start: moved.toISOString() } })).status).toBe(200);
    expect(fakeProviders.callsTo('google', 'PATCH', new RegExp(`/events/${eventId}$`))).toHaveLength(1);
    expect(google().events.get(eventId)!.start.dateTime).toBe(moved.toISOString());
    expect(google().events.size).toBe(1);
    const [afterMove] = await db.select().from(calendarEvents);
    expect(afterMove).toMatchObject({ status: 'synced', syncedVersion: 2 });

    expect((await call(cancelRoute, { path: '/x', params: { id: interview.id }, body: { reason: 'Role filled' } })).status).toBe(200);
    expect(google().events.get(eventId)!.status).toBe('cancelled');
    const [afterCancel] = await db.select().from(calendarEvents);
    expect(afterCancel).toMatchObject({ status: 'cancelled', syncedVersion: 3 });
  });

  it('creation is idempotent: a retried insert updates the existing event instead of duplicating it', async () => {
    const w = await connected();
    const row = (await integrationRow(w.host.id, 'google_calendar'))!;
    const input = {
      interviewId: randomUUID(),
      title: 'Retry test',
      description: 'd',
      location: null,
      start: upcomingWeekday(TZ, '10:00'),
      end: upcomingWeekday(TZ, '11:00'),
      timezone: TZ,
      attendees: [],
      notifyAttendees: false,
      sourceUrl: null,
    };
    const first = await googleCalendarProvider.createEvent(tokenSourceFor(row.id), PRIMARY, input);
    const second = await googleCalendarProvider.createEvent(tokenSourceFor(row.id), PRIMARY, { ...input, title: 'Retry test (2)' });
    expect(second.externalEventId).toBe(first.externalEventId);
    expect(google().events.size).toBe(1);
    expect(google().events.get(first.externalEventId)!.summary).toBe('Retry test (2)');
  });

  it('records a failed sync, keeps the booking, and heals on retry', async () => {
    const w = await connected();
    fakeProviders.failNext({ provider: 'google', method: 'POST', path: /\/events$/, status: 500 });
    expect((await book(w.host, w.eventType, upcomingWeekday(TZ, '10:00'))).status).toBe(201);
    const [interview] = await db.select().from(interviews);
    const [failed] = await db.select().from(calendarEvents);
    expect(failed.status).toBe('failed');
    expect(failed.lastError).toContain('500');
    expect((await db.select().from(auditLogs).where(eq(auditLogs.action, 'integration.failure'))).length).toBe(1);
    // A background retry job is queued for the interview.
    expect((await jobs('interview-sync')).some((j) => j.singletonKey === interview.id)).toBe(true);

    await signIn(w.host);
    const retry = await call(syncRoute, { path: '/x', params: { id: interview.id }, body: {} });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ calendar: 'ok', retryable: false });
    const [healed] = await db.select().from(calendarEvents);
    expect(healed.status).toBe('synced');
    expect((await db.select().from(auditLogs).where(eq(auditLogs.action, 'integration.recovered'))).length).toBe(1);
  });
});

describe('token refresh', () => {
  it('refreshes an expired access token on 401 and retries transparently', async () => {
    const w = await connected();
    const before = (await integrationRow(w.host.id, 'google_calendar'))!;
    google().expireAccessTokens();

    expect((await book(w.host, w.eventType, upcomingWeekday(TZ, '10:00'))).status).toBe(201);
    const refreshCalls = fakeProviders.callsTo('google', 'POST', /^\/token$/).filter((c) => (c.body as Record<string, string>).grant_type === 'refresh_token');
    expect(refreshCalls).toHaveLength(1);
    const after = (await integrationRow(w.host.id, 'google_calendar'))!;
    expect(decrypt(after.accessTokenEncrypted!)).not.toBe(decrypt(before.accessTokenEncrypted!));
    // Google does not rotate refresh tokens; the stored one is kept.
    expect(decrypt(after.refreshTokenEncrypted!)).toBe(decrypt(before.refreshTokenEncrypted!));
    expect(google().liveEvents()).toHaveLength(1);
  });

  it('refreshes proactively when the stored token is about to expire', async () => {
    const w = await connected();
    const row = (await integrationRow(w.host.id, 'google_calendar'))!;
    await db.update(integrations).set({ tokenExpiresAt: new Date(Date.now() + 10_000) }).where(eq(integrations.id, row.id));
    fakeProviders.calls = [];
    const res = await slotsOn(w.host, w.eventType, upcomingWeekday(TZ, '00:00'));
    expect(res.status).toBe(200);
    // Refresh happened first, so Google never saw a request with a stale token.
    expect(fakeProviders.calls.map((c) => c.path)).toEqual(['/token', '/calendar/v3/freeBusy']);
  });

  it('serialises concurrent refreshes so only one refresh request is made', async () => {
    const w = await connected();
    google().expireAccessTokens();
    const days = [0, 1, 2, 3].map((d) => addMinutes(upcomingWeekday(TZ, '00:00'), d * 1440));
    const results = await Promise.all(days.map((d) => slotsOn(w.host, w.eventType, d)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const refreshes = fakeProviders.callsTo('google', 'POST', /^\/token$/).filter((c) => (c.body as Record<string, string>).grant_type === 'refresh_token');
    expect(refreshes).toHaveLength(1);
  });

  it('marks the integration as needing reconnection when Google revokes the grant', async () => {
    const w = await connected();
    google().revokeGrant();
    const res = await slotsOn(w.host, w.eventType, upcomingWeekday(TZ, '00:00'));
    expect(res.status).toBe(503);
    const row = (await integrationRow(w.host.id, 'google_calendar'))!;
    expect(row.status).toBe('error');
    expect(row.lastError).toMatch(/revoked|expired/i);
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, 'integration.failure'));
    expect(audit.metadata).toMatchObject({ provider: 'google_calendar', requiresReconnect: true });

    // Reconnecting restores the integration and the page recovers.
    await connect('google', w.host, w.org);
    expect((await integrationRow(w.host.id, 'google_calendar'))!.status).toBe('active');
    expect((await slotsOn(w.host, w.eventType, upcomingWeekday(TZ, '00:00'))).status).toBe(200);
  });
});

describe('Google push notifications (webhook)', () => {
  async function channelHeaders() {
    const [channel] = [...google().channels.entries()];
    const [id, c] = channel;
    return { 'x-goog-channel-id': id, 'x-goog-channel-token': c.token, 'x-goog-resource-id': c.resourceId };
  }

  function notify(headers: Record<string, string>, state: string, messageNumber: string) {
    return call(googleWebhookRoute, {
      method: 'POST',
      path: '/api/webhooks/google',
      headers: { ...headers, 'x-goog-resource-state': state, 'x-goog-message-number': messageNumber },
      origin: false,
    });
  }

  it('authenticates notifications by channel token and de-duplicates deliveries', async () => {
    await connected();
    const h = await channelHeaders();
    expect((await notify({ ...h, 'x-goog-channel-token': 'wrong-token' }, 'exists', '2')).status).toBe(401);
    expect((await notify({ ...h, 'x-goog-channel-id': randomUUID() }, 'exists', '2')).status).toBe(401);
    expect((await notify(h, 'sync', '1')).status).toBe(204);
    expect((await notify(h, 'exists', '2')).status).toBe(204);
    expect((await notify(h, 'exists', '2')).status).toBe(204); // duplicate delivery
    expect(await db.select().from(webhookEvents)).toHaveLength(1);
    expect(await jobs('webhook-process')).toHaveLength(1);
  });

  it('keeps a delivery for retry when processing fails, and marks it failed after the last attempt', async () => {
    await connected();
    const h = await channelHeaders();
    await notify(h, 'exists', '9');
    const [evt] = await db.select().from(webhookEvents);

    fakeProviders.failNext({ provider: 'google', method: 'GET', path: /\/events$/, status: 500, times: 2 });
    await expect(processWebhookEvent(evt.id)).rejects.toThrow(/500/);
    let [row] = await db.select().from(webhookEvents);
    expect(row).toMatchObject({ status: 'received', attempts: 1 });
    expect(row.error).toContain('500');

    await expect(processWebhookEvent(evt.id, { finalAttempt: true })).rejects.toThrow();
    [row] = await db.select().from(webhookEvents);
    expect(row).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('flags interview events deleted or moved directly in Google Calendar, and retry re-creates them', async () => {
    const w = await connected();
    await book(w.host, w.eventType, upcomingWeekday(TZ, '10:00'));
    const [interview] = await db.select().from(interviews);
    const eventId = googleEventIdFor(interview.id);
    const h = await channelHeaders();

    google().deleteEventExternally(eventId);
    await notify(h, 'exists', '5');
    const [evt] = await db.select().from(webhookEvents);
    await processWebhookEvent(evt.id);
    const [row] = await db.select().from(calendarEvents);
    expect(row.status).toBe('deleted_externally');
    const [processed] = await db.select().from(webhookEvents);
    expect(processed.status).toBe('processed');
    const changes = await db.select().from(auditLogs).where(eq(auditLogs.action, 'integration.external_change'));
    expect(changes[0].metadata).toMatchObject({ provider: 'google_calendar', change: 'event_deleted' });

    // The interviewer chooses to restore it from Slate.
    await signIn(w.host);
    const retry = await call(syncRoute, { path: '/x', params: { id: interview.id }, body: {} });
    expect(retry.body.calendar).toBe('ok');
    expect(google().events.get(eventId)!.status).toBe('confirmed');

    // Moving it in Google is reported (the candidate's time is never changed silently).
    google().moveEventExternally(eventId, upcomingWeekday(TZ, '16:00'), upcomingWeekday(TZ, '17:00'));
    await notify(h, 'exists', '6');
    const pending = (await db.select().from(webhookEvents)).find((e) => e.status === 'received')!;
    await processWebhookEvent(pending.id);
    const moved = await db.select().from(auditLogs).where(eq(auditLogs.action, 'integration.external_change'));
    expect(moved.map((m) => m.metadata.change)).toContain('event_moved');
    const [unchanged] = await db.select().from(interviews);
    expect(unchanged.startAt.toISOString()).toBe(upcomingWeekday(TZ, '10:00').toISOString());
  });
});
