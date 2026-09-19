import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { POST as bookRoute } from '@/app/api/public/book/[username]/[eventSlug]/route';
import { GET as bookingViewRoute } from '@/app/api/public/bookings/[token]/route';
import { GET as detailRoute } from '@/app/api/interviews/[id]/route';
import { POST as rescheduleRoute } from '@/app/api/interviews/[id]/reschedule/route';
import { POST as cancelRoute } from '@/app/api/interviews/[id]/cancel/route';
import { GET as zoomStartRoute } from '@/app/api/interviews/[id]/zoom/start/route';
import { POST as zoomWebhookRoute } from '@/app/api/webhooks/zoom/route';
import { GET as connectLinkRoute } from '@/app/(app)/integrations/connect/[provider]/route';
import { GET as oauthCallbackRoute } from '@/app/api/integrations/[provider]/callback/route';
import { db } from '@/server/db/client';
import { auditLogs, candidates, interviews, oauthStates, videoMeetings, webhookEvents } from '@/server/db/schema';
import { googleEventIdFor } from '@/server/integrations/google/calendar';
import { processWebhookEvent } from '@/server/integrations/webhooks';
import { handleInterviewSync } from '@/server/jobs/handlers';
import { decrypt, hmacSha256Hex } from '@/server/security/crypto';
import { deliverDueNotifications, jobs, notificationsFor } from '../helpers/db';
import { fakeProviders } from '../helpers/fake-providers';
import { createEventType, createMember, createOrg, signIn, signOut, upcomingWeekday, type EventType, type User } from '../helpers/fixtures';
import { call } from '../helpers/http';
import { connect, integrationRow } from '../helpers/integrations';
import { outbox } from '../helpers/outbox';

const TZ = 'America/New_York';
const zoom = () => fakeProviders.zoom;

async function world() {
  const org = await createOrg();
  const host = await createMember(org, { role: 'interviewer', name: 'Priya Nair', timezone: TZ });
  const recruiter = await createMember(org, { role: 'recruiter' });
  const eventType = await createEventType(org, host, { name: 'Technical Interview', locationType: 'zoom', durationMinutes: 60 });
  return { org, host, recruiter, eventType };
}

async function withZoom() {
  const w = await world();
  const { callback } = await connect('zoom', w.host, w.org);
  expect(callback.location).toBe('http://localhost:3000/integrations?connected=zoom');
  return w;
}

function book(host: User, eventType: EventType, start: Date, email = `riley-${randomUUID().slice(0, 6)}@candidate.test`) {
  return call(bookRoute, {
    path: '/x',
    params: { username: host.username, eventSlug: eventType.slug },
    body: { start: start.toISOString(), name: 'Riley Carter', email, timezone: 'Europe/London', answers: {} },
    origin: false,
  });
}

const JOB = { retryCount: 0, retryLimit: 10 };

describe('Zoom OAuth flow', () => {
  it('authorizes with PKCE, authenticates the client with Basic auth, and stores encrypted tokens', async () => {
    const w = await world();
    const { authorizationUrl } = await connect('zoom', w.host, w.org);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe('https://zoom.us/oauth/authorize');
    expect(authorizationUrl.searchParams.get('client_id')).toBe(process.env.ZOOM_CLIENT_ID);
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/integrations/zoom/callback');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');

    const [exchange] = fakeProviders.callsTo('zoom', 'POST', /^\/oauth\/token$/);
    expect(exchange.headers.authorization).toMatch(/^Basic /);
    // The client secret is sent only in the Authorization header to Zoom's token endpoint.
    expect(JSON.stringify(exchange.body)).not.toContain(process.env.ZOOM_CLIENT_SECRET);

    const row = (await integrationRow(w.host.id, 'zoom'))!;
    expect(row).toMatchObject({ status: 'active', externalAccountId: zoom().account.id, externalAccountEmail: zoom().account.email });
    expect(decrypt(row.accessTokenEncrypted!)).toMatch(/^z-at-/);
    expect(decrypt(row.refreshTokenEncrypted!)).toMatch(/^z-rt-/);
  });
});

describe('Zoom meeting lifecycle', () => {
  it('creates a meeting with the right time, duration, zone and invitee when a candidate books', async () => {
    const w = await withZoom();
    const start = upcomingWeekday(TZ, '10:00');
    expect((await book(w.host, w.eventType, start, 'riley@candidate.test')).status).toBe(201);

    const [create] = fakeProviders.callsTo('zoom', 'POST', /^\/v2\/users\/me\/meetings$/);
    expect(create.body).toMatchObject({
      topic: 'Technical Interview — Riley Carter',
      type: 2,
      start_time: start.toISOString().replace('.000Z', 'Z'),
      duration: 60,
      timezone: TZ,
      settings: { meeting_invitees: [{ email: 'riley@candidate.test' }], waiting_room: true, join_before_host: false },
    });

    const [interview] = await db.select().from(interviews);
    const [meeting] = await db.select().from(videoMeetings).where(eq(videoMeetings.interviewId, interview.id));
    const remote = zoom().meetings.get(meeting.externalMeetingId!)!;
    expect(meeting).toMatchObject({ status: 'synced', syncedVersion: 1, joinUrl: remote.join_url, passcode: remote.password });
    // The host start URL is stored encrypted, never in plaintext.
    expect(meeting.hostUrlEncrypted).not.toContain('zak=');
    expect(decrypt(meeting.hostUrlEncrypted!)).toBe(remote.start_url);
  });

  it('gives the candidate the join link but never the host start link', async () => {
    const w = await withZoom();
    const res = await book(w.host, w.eventType, upcomingWeekday(TZ, '10:00'), 'riley@candidate.test');
    const [meeting] = await db.select().from(videoMeetings);
    const remote = zoom().meetings.get(meeting.externalMeetingId!)!;

    await deliverDueNotifications();
    const [confirmation] = outbox.to('riley@candidate.test');
    expect(confirmation.text).toContain(remote.join_url);
    expect(confirmation.html).toContain(remote.join_url);
    expect(confirmation.icalEvent?.content).toContain('LOCATION:https://us06web.zoom.us/j/');
    const allCandidateMail = JSON.stringify(outbox.to('riley@candidate.test'));
    expect(allCandidateMail).not.toContain('zak=');
    // The host notification links to Calendor, not to the raw start URL.
    expect(JSON.stringify(outbox.to(w.host.email))).not.toContain('zak=');

    const view = await call(bookingViewRoute, { path: '/x', params: { token: res.body.confirmationUrl.split('/').pop() } });
    expect(view.body.location).toMatchObject({ type: 'zoom', joinUrl: remote.join_url, pending: false });
    expect(JSON.stringify(view.body)).not.toContain('zak=');

    // Dashboard details don't embed it either; the host gets it via a no-store redirect.
    const [interview] = await db.select().from(interviews);
    await signIn(w.host);
    const detail = await call(detailRoute, { path: '/x', params: { id: interview.id } });
    expect(JSON.stringify(detail.body)).not.toContain('zak=');
    const start = await call(zoomStartRoute, { path: '/x', params: { id: interview.id } });
    expect(start.status).toBe(302);
    expect(start.location).toMatch(/zak=fresh-/); // freshly fetched from Zoom
    expect(start.headers.get('cache-control')).toBe('no-store');
    expect(start.headers.get('referrer-policy')).toBe('no-referrer');
    signOut();

    await signIn(w.recruiter);
    expect((await call(zoomStartRoute, { path: '/x', params: { id: interview.id } })).status).toBe(403);
  });

  it('adds the Zoom link to the Google Calendar event when both are connected', async () => {
    const w = await withZoom();
    await connect('google', w.host, w.org);
    await book(w.host, w.eventType, upcomingWeekday(TZ, '10:00'));
    const [interview] = await db.select().from(interviews);
    const [meeting] = await db.select().from(videoMeetings);
    const event = fakeProviders.google.events.get(googleEventIdFor(interview.id))!;
    expect(event.location).toBe(meeting.joinUrl);
    expect(event.description).toContain(`Join Zoom meeting: ${meeting.joinUrl}`);
    expect(event.description).not.toContain('zak=');
  });

  it('updates the meeting when the interview is rescheduled and deletes it when cancelled', async () => {
    const w = await withZoom();
    await book(w.host, w.eventType, upcomingWeekday(TZ, '10:00'));
    const [interview] = await db.select().from(interviews);
    const [meeting] = await db.select().from(videoMeetings);
    const id = meeting.externalMeetingId!;

    await signIn(w.host);
    const moved = upcomingWeekday(TZ, '15:30', 6);
    expect((await call(rescheduleRoute, { path: '/x', params: { id: interview.id }, body: { start: moved.toISOString() } })).status).toBe(200);
    const [patch] = fakeProviders.callsTo('zoom', 'PATCH', new RegExp(`/meetings/${id}$`));
    expect(patch.body).toMatchObject({ start_time: moved.toISOString().replace('.000Z', 'Z'), duration: 60, timezone: TZ });
    const [afterMove] = await db.select().from(videoMeetings);
    expect(afterMove).toMatchObject({ status: 'synced', syncedVersion: 2, joinUrl: meeting.joinUrl, externalMeetingId: id });

    // The candidate's reschedule email carries the (unchanged) join link and the new time.
    await deliverDueNotifications();
    const [cand] = await db.select().from(candidates);
    const rescheduled = outbox.to(cand.email).find((m) => m.subject.startsWith('Rescheduled'))!;
    expect(rescheduled.text).toContain(meeting.joinUrl!);

    expect((await call(cancelRoute, { path: '/x', params: { id: interview.id }, body: { reason: 'Hiring freeze' } })).status).toBe(200);
    expect(zoom().deleted).toEqual([id]);
    expect(zoom().meetings.has(id)).toBe(false);
    const [afterCancel] = await db.select().from(videoMeetings);
    expect(afterCancel.status).toBe('cancelled');
  });

  it('re-creates a meeting that was deleted directly in Zoom when the interview changes', async () => {
    const w = await withZoom();
    await book(w.host, w.eventType, upcomingWeekday(TZ, '10:00'));
    const [interview] = await db.select().from(interviews);
    const [original] = await db.select().from(videoMeetings);
    zoom().deleteMeetingExternally(original.externalMeetingId!);

    await signIn(w.host);
    await call(rescheduleRoute, { path: '/x', params: { id: interview.id }, body: { start: upcomingWeekday(TZ, '14:00', 4).toISOString() } });
    const [recreated] = await db.select().from(videoMeetings);
    expect(recreated.status).toBe('synced');
    expect(recreated.externalMeetingId).not.toBe(original.externalMeetingId);
    expect(zoom().meetings.has(recreated.externalMeetingId!)).toBe(true);
  });
});

describe('Zoom API failure handling', () => {
  it('keeps the booking, records the failure, retries in the background and emails the link once available', async () => {
    const w = await withZoom();
    fakeProviders.failNext({ provider: 'zoom', method: 'POST', path: /\/users\/me\/meetings$/, status: 500, body: { code: 500, message: 'Internal error' }, times: 2 });
    const res = await book(w.host, w.eventType, upcomingWeekday(TZ, '10:00'), 'riley@candidate.test');
    expect(res.status).toBe(201);

    const [interview] = await db.select().from(interviews);
    const [failed] = await db.select().from(videoMeetings);
    expect(failed.status).toBe('failed');
    expect(failed.lastError).toContain('Create Zoom meeting failed (500)');
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, 'integration.failure'));
    expect(audit.metadata).toMatchObject({ provider: 'zoom', retryable: true });
    expect((await jobs('interview-sync')).some((j) => j.singletonKey === interview.id)).toBe(true);

    // The confirmation is not held back forever: it goes out and says the link will follow.
    await deliverDueNotifications();
    const [confirmation] = outbox.to('riley@candidate.test');
    expect(confirmation.text).toContain('Zoom (link to follow)');
    const view = await call(bookingViewRoute, { path: '/x', params: { token: res.body.confirmationUrl.split('/').pop() } });
    expect(view.body.location).toMatchObject({ joinUrl: null, pending: true });

    // First background attempt still fails → the job throws so pg-boss retries with backoff.
    await expect(handleInterviewSync({ interviewId: interview.id, reason: 'booked' }, JOB)).rejects.toThrow(/Integration sync incomplete/);
    // Zoom recovers → the next attempt succeeds and the candidate gets a follow-up email with the link.
    await expect(handleInterviewSync({ interviewId: interview.id, reason: 'booked' }, { retryCount: 2, retryLimit: 10 })).resolves.toMatchObject({ meeting: 'ok' });
    const [synced] = await db.select().from(videoMeetings);
    expect(synced.status).toBe('synced');
    expect((await db.select().from(auditLogs).where(eq(auditLogs.action, 'integration.recovered'))).length).toBe(1);

    await deliverDueNotifications();
    const followUp = outbox.to('riley@candidate.test').find((m) => m !== confirmation)!;
    expect(followUp.text).toContain(synced.joinUrl!);
    expect((await notificationsFor(interview.id)).map((n) => n.type)).toContain('meeting_details_update');
  });

  it('classifies rate limiting and network errors as retryable', async () => {
    const w = await withZoom();
    fakeProviders.failNext({ provider: 'zoom', method: 'POST', path: /\/users\/me\/meetings$/, status: 429, headers: { 'retry-after': '30' }, body: { code: 429, message: 'Too many requests' } });
    await book(w.host, w.eventType, upcomingWeekday(TZ, '10:00'));
    const [interview] = await db.select().from(interviews);
    expect((await db.select().from(videoMeetings))[0].lastError).toContain('429');

    fakeProviders.failNext({ provider: 'zoom', method: 'POST', path: /\/users\/me\/meetings$/, networkError: true });
    await expect(handleInterviewSync({ interviewId: interview.id, reason: 'retry' }, JOB)).rejects.toThrow(/Network error/);
    await expect(handleInterviewSync({ interviewId: interview.id, reason: 'retry' }, JOB)).resolves.toMatchObject({ meeting: 'ok' });
  });

  it('treats a missing Zoom connection as a permanent failure that heals when Zoom is connected', async () => {
    const w = await world();
    expect((await book(w.host, w.eventType, upcomingWeekday(TZ, '10:00'))).status).toBe(201);
    const [interview] = await db.select().from(interviews);
    const [meeting] = await db.select().from(videoMeetings);
    expect(meeting).toMatchObject({ status: 'failed', lastError: 'Zoom is not connected for this interviewer.' });
    // Not retryable: the job completes instead of burning retries.
    await expect(handleInterviewSync({ interviewId: interview.id, reason: 'booked' }, JOB)).resolves.toMatchObject({ meeting: 'failed', retryable: false });

    // The booking's own sync job has finished by the time the interviewer connects Zoom.
    await db.execute(sql`DELETE FROM pgboss.job WHERE name = 'interview-sync'`);
    await connect('zoom', w.host, w.org);
    // Connecting re-enqueues sync for affected upcoming interviews.
    const queued = (await jobs<{ interviewId: string; reason: string }>('interview-sync')).filter((j) => j.data.reason === 'zoom_reconnected');
    expect(queued.map((j) => j.data.interviewId)).toEqual([interview.id]);
    await handleInterviewSync(queued[0].data, JOB);
    expect((await db.select().from(videoMeetings))[0].status).toBe('synced');
  });

  it('persists rotated refresh tokens so later refreshes keep working', async () => {
    const w = await withZoom();
    const first = decrypt((await integrationRow(w.host.id, 'zoom'))!.refreshTokenEncrypted!);

    zoom().expireAccessTokens();
    expect((await book(w.host, w.eventType, upcomingWeekday(TZ, '10:00'))).status).toBe(201);
    const second = decrypt((await integrationRow(w.host.id, 'zoom'))!.refreshTokenEncrypted!);
    expect(second).not.toBe(first);

    zoom().expireAccessTokens();
    expect((await book(w.host, w.eventType, upcomingWeekday(TZ, '14:00'))).status).toBe(201);
    expect((await db.select().from(videoMeetings)).every((m) => m.status === 'synced')).toBe(true);
    const refreshes = fakeProviders.callsTo('zoom', 'POST', /^\/oauth\/token$/).filter((c) => (c.body as Record<string, string>).grant_type === 'refresh_token');
    expect(refreshes.map((c) => (c.body as Record<string, string>).refresh_token)).toEqual([first, second]);
  });
});

describe('Zoom webhooks', () => {
  const secret = () => process.env.ZOOM_WEBHOOK_SECRET_TOKEN!;

  function signed(body: unknown, opts: { timestamp?: number; secret?: string } = {}) {
    const raw = JSON.stringify(body);
    const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
    const signature = `v0=${hmacSha256Hex(opts.secret ?? secret(), `v0:${ts}:${raw}`)}`;
    return call(zoomWebhookRoute, {
      method: 'POST',
      path: '/api/webhooks/zoom',
      body: raw,
      headers: { 'x-zm-request-timestamp': ts, 'x-zm-signature': signature },
      origin: false,
    });
  }

  it('verifies signatures and rejects replays', async () => {
    const body = { event: 'meeting.deleted', payload: { object: { id: 1 } } };
    expect((await signed(body, { secret: 'wrong-secret' })).status).toBe(401);
    expect((await signed(body, { timestamp: Math.floor(Date.now() / 1000) - 600 })).status).toBe(401);
    const unsigned = await call(zoomWebhookRoute, { method: 'POST', path: '/x', body, origin: false });
    expect(unsigned.status).toBe(401);
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
  });

  it('answers the endpoint URL validation challenge', async () => {
    const res = await signed({ event: 'endpoint.url_validation', payload: { plainToken: 'qgg8vlvZRS6UYooatFL8Aw' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ plainToken: 'qgg8vlvZRS6UYooatFL8Aw', encryptedToken: hmacSha256Hex(secret(), 'qgg8vlvZRS6UYooatFL8Aw') });
  });

  it('records each delivery once and flags meetings deleted in Zoom', async () => {
    const w = await withZoom();
    await book(w.host, w.eventType, upcomingWeekday(TZ, '10:00'));
    const [meeting] = await db.select().from(videoMeetings);
    const body = { event: 'meeting.deleted', event_ts: Date.now(), payload: { account_id: 'acc', object: { id: Number(meeting.externalMeetingId), host_id: zoom().account.id } } };
    expect((await signed(body)).status).toBe(204);
    expect((await signed(body)).status).toBe(204); // duplicate delivery
    const events = await db.select().from(webhookEvents);
    expect(events).toHaveLength(1);

    await processWebhookEvent(events[0].id);
    await processWebhookEvent(events[0].id); // idempotent
    const [flagged] = await db.select().from(videoMeetings);
    expect(flagged.status).toBe('deleted_externally');
    const changes = await db.select().from(auditLogs).where(eq(auditLogs.action, 'integration.external_change'));
    expect(changes).toHaveLength(1);
    expect((await db.select().from(webhookEvents))[0].status).toBe('processed');
  });

  it('marks the integration disconnected when the app is deauthorized in Zoom', async () => {
    const w = await withZoom();
    await signed({ event: 'app_deauthorized', event_ts: Date.now(), payload: { user_id: zoom().account.id, account_id: 'acc' } });
    const [evt] = await db.select().from(webhookEvents);
    await processWebhookEvent(evt.id);
    const row = (await integrationRow(w.host.id, 'zoom'))!;
    expect(row).toMatchObject({ status: 'error', accessTokenEncrypted: null, refreshTokenEncrypted: null });
    expect(row.lastError).toMatch(/Reconnect Zoom/);
  });

  it('acknowledges but ignores events about meetings Calendor does not manage', async () => {
    await withZoom();
    expect((await signed({ event: 'meeting.deleted', event_ts: 1, payload: { object: { id: 42 } } })).status).toBe(204);
    expect((await signed({ event: 'recording.completed', event_ts: 2, payload: {} })).status).toBe(204);
    for (const evt of await db.select().from(webhookEvents)) await processWebhookEvent(evt.id);
    expect((await db.select().from(webhookEvents)).map((e) => e.status)).toEqual(['ignored', 'ignored']);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, 'integration.external_change'))).toHaveLength(0);
  });
});

describe('Zoom app scopes', () => {
  it('refuses the connection and names the scopes missing from the Zoom Marketplace app', async () => {
    const w = await world();
    // An app configured with meeting scopes but not user:read:user (Zoom would 400 on GET /users/me).
    const { callback } = await connect('zoom', w.host, w.org, { scopes: ['meeting:write:meeting', 'meeting:read:meeting'] });
    const location = new URL(callback.location!);
    expect(location.pathname).toBe('/integrations');
    expect(location.searchParams.get('error')).toBe('connect_failed');
    expect(location.searchParams.get('message')).toBe(
      'The Zoom app is missing scopes: user:read:user, meeting:update:meeting, meeting:delete:meeting. Add them on marketplace.zoom.us, then connect again.',
    );
    expect(await integrationRow(w.host.id, 'zoom')).toBeNull();
  });

  it('accepts apps configured with classic (non-granular) scopes', async () => {
    const w = await world();
    const { callback } = await connect('zoom', w.host, w.org, { scopes: ['meeting:write', 'user:read'] });
    expect(callback.location).toBe('http://localhost:3000/integrations?connected=zoom');
    expect((await integrationRow(w.host.id, 'zoom'))?.status).toBe('active');
  });
});

describe('shareable connect link (/integrations/connect/:provider)', () => {
  const openLink = (provider: string, headers?: Record<string, string>) =>
    call(connectLinkRoute, { path: `/integrations/connect/${provider}`, params: { provider }, headers });
  const finish = (grant: { code: string; state: string }) =>
    call(oauthCallbackRoute, {
      path: `/api/integrations/zoom/callback?code=${encodeURIComponent(grant.code)}&state=${encodeURIComponent(grant.state)}`,
      params: { provider: 'zoom' },
    });

  it('starts OAuth for whoever is signed in to this browser and lands on the integrations page', async () => {
    const w = await world();
    await signIn(w.host, w.org);
    const start = await openLink('zoom');
    expect(start.status).toBe(303);
    expect(start.headers.get('cache-control')).toBe('no-store');
    expect(start.location).toMatch(/^https:\/\/zoom\.us\/oauth\/authorize\?/);
    const done = await finish(zoom().authorize(start.location!));
    expect(done.location).toBe('http://localhost:3000/integrations?connected=zoom');
    expect((await integrationRow(w.host.id, 'zoom'))?.status).toBe('active');
    signOut();
  });

  it('sends a browser that is not signed in to Calendor to sign in first, then back to the link', async () => {
    signOut();
    const res = await openLink('google');
    expect(res.status).toBe(303);
    expect(res.location).toBe('http://localhost:3000/login?next=%2Fintegrations%2Fconnect%2Fgoogle');
  });

  it('cannot attach an account to a different Calendor user than the one who opened the link', async () => {
    const w = await world();
    await signIn(w.host, w.org);
    const grant = zoom().authorize((await openLink('zoom')).location!);
    await signIn(w.recruiter, w.org); // the link was forwarded to, and completed in, someone else's session
    const done = await finish(grant);
    expect(new URL(done.location!).searchParams.get('error')).toBe('connect_failed');
    expect(await integrationRow(w.recruiter.id, 'zoom')).toBeNull();
    expect(await integrationRow(w.host.id, 'zoom')).toBeNull();
    signOut();
  });

  it('answers client-side (RSC) navigations without starting OAuth, so the router does a full page load', async () => {
    const w = await world();
    await signIn(w.host, w.org);
    const res = await openLink('zoom', { rsc: '1' });
    expect(res.status).toBe(204);
    expect(await db.select().from(oauthStates).where(eq(oauthStates.userId, w.host.id))).toHaveLength(0);
    signOut();
  });

  it('rejects unknown providers', async () => {
    const w = await world();
    await signIn(w.host, w.org);
    expect((await openLink('slack')).location).toBe('http://localhost:3000/integrations?error=unknown_provider');
    signOut();
  });
});
