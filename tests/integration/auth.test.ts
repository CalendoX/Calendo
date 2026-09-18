import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { POST as loginRoute } from '@/app/api/auth/login/route';
import { POST as logoutRoute } from '@/app/api/auth/logout/route';
import { GET as meRoute } from '@/app/api/auth/me/route';
import { POST as signupRoute } from '@/app/api/auth/signup/route';
import { POST as forgotRoute } from '@/app/api/auth/forgot-password/route';
import { POST as resetRoute } from '@/app/api/auth/reset-password/route';
import { POST as verifyRoute } from '@/app/api/auth/verify-email/route';
import { POST as acceptInviteRoute } from '@/app/api/auth/accept-invite/route';
import { GET as adminUsersRoute, POST as inviteRoute } from '@/app/api/admin/users/route';
import { GET as adminUserRoute, PATCH as updateUserRoute } from '@/app/api/admin/users/[id]/route';
import { GET as auditRoute } from '@/app/api/admin/audit-logs/route';
import { GET as statsRoute } from '@/app/api/admin/stats/route';
import { GET as listInterviewsRoute, POST as createInterviewRoute } from '@/app/api/interviews/route';
import { GET as interviewRoute } from '@/app/api/interviews/[id]/route';
import { POST as cancelRoute } from '@/app/api/interviews/[id]/cancel/route';
import { POST as createEventTypeRoute } from '@/app/api/event-types/route';
import { PATCH as updateEventTypeRoute } from '@/app/api/event-types/[id]/route';
import { GET as availabilityRoute } from '@/app/api/availability/route';
import { GET as scheduleRoute, PUT as scheduleUpdateRoute } from '@/app/api/availability/[id]/route';
import { GET as zoomStartRoute } from '@/app/api/interviews/[id]/zoom/start/route';
import { SESSION_IDLE_TIMEOUT_MS, sessionCookieName } from '@/server/auth/session';
import { db } from '@/server/db/client';
import { auditLogs, memberships, rateLimits, sessions, users } from '@/server/db/schema';
import { lastAccountEmailUrl } from '../helpers/db';
import { cookieJar } from '../helpers/cookie-jar';
import { createEventType, createMember, createOrg, signIn, signOut, TEST_PASSWORD, upcomingWeekday, type User } from '../helpers/fixtures';
import { call } from '../helpers/http';

const COOKIE = () => sessionCookieName();

function login(email: string, password: string, ip = '10.2.0.1') {
  return call(loginRoute, { path: '/api/auth/login', body: { email, password }, ip });
}

function validEventType(name: string) {
  return { name, durationMinutes: 45, locationType: 'phone', locationDetails: '+1 555 0100' };
}

function me() {
  return call(meRoute, { path: '/api/auth/me' });
}

describe('login and logout', () => {
  it('creates a session with a hardened cookie and resolves the current user', async () => {
    const org = await createOrg();
    const user = await createMember(org, { role: 'recruiter' });
    expect((await me()).status).toBe(401);

    const res = await login(user.email.toUpperCase(), TEST_PASSWORD);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|token/i);
    expect(cookieJar.optionsFor(COOKIE())).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
    // Only an HMAC of the session token is stored.
    const raw = cookieJar.get(COOKIE())!.value;
    const rows = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toBe(raw);

    const current = await me();
    expect(current.status).toBe(200);
    expect(current.body).toMatchObject({ user: { id: user.id, email: user.email }, role: 'recruiter', organization: { id: org.id } });
  });

  it('rejects wrong passwords and unknown accounts with the same message', async () => {
    const org = await createOrg();
    const user = await createMember(org);
    const wrong = await login(user.email, 'not-the-password');
    const unknown = await login('nobody@example.test', 'not-the-password');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    expect(cookieJar.get(COOKIE())).toBeUndefined();
  });

  it('locks the account after repeated failures', async () => {
    const org = await createOrg();
    const user = await createMember(org);
    for (let i = 0; i < 10; i++) expect((await login(user.email, `wrong-${i}`, `10.3.0.${i}`)).status).toBe(401);
    // The per-email rate limit now blocks further attempts outright…
    const limited = await login(user.email, TEST_PASSWORD, '10.3.1.1');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
    // …and independently the account itself is locked, even with the right password.
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    await db.delete(rateLimits);
    const locked = await login(user.email, TEST_PASSWORD, '10.3.1.2');
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('logout revokes the session server-side', async () => {
    const org = await createOrg();
    const user = await createMember(org);
    await login(user.email, TEST_PASSWORD);
    const token = cookieJar.get(COOKIE())!.value;
    expect((await call(logoutRoute, { path: '/api/auth/logout', body: {} })).status).toBe(200);
    expect(cookieJar.get(COOKIE())).toBeUndefined();
    // Replaying the old cookie no longer works.
    cookieJar.set(COOKIE(), token);
    expect((await me()).status).toBe(401);
    const [row] = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(row.revokedAt).not.toBeNull();
  });

  it('expires idle sessions and sessions of deactivated users', async () => {
    const org = await createOrg();
    const user = await createMember(org);
    const session = await signIn(user);
    expect((await me()).status).toBe(200);
    await db.update(sessions).set({ lastSeenAt: new Date(Date.now() - SESSION_IDLE_TIMEOUT_MS - 60_000) }).where(eq(sessions.id, session.sessionId));
    expect((await me()).status).toBe(401);

    await signIn(user);
    await db.update(users).set({ status: 'deactivated' }).where(eq(users.id, user.id));
    expect((await me()).status).toBe(401);
    expect((await login(user.email, TEST_PASSWORD)).status).toBe(401);
  });

  it('rejects cross-site mutation requests (CSRF)', async () => {
    const org = await createOrg();
    const admin = await createMember(org, { role: 'admin' });
    await signIn(admin);
    const res = await call(inviteRoute, {
      path: '/api/admin/users',
      body: { name: 'Mallory', email: 'mallory@evil.test', role: 'admin' },
      origin: 'https://evil.example',
    });
    expect(res.status).toBe(403);
    const sneaky = await call(inviteRoute, {
      path: '/api/admin/users',
      body: { name: 'Mallory', email: 'mallory@evil.test', role: 'admin' },
      origin: false,
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(sneaky.status).toBe(403);
    expect(await db.select().from(users).where(eq(users.email, 'mallory@evil.test'))).toHaveLength(0);
  });
});

describe('password reset', () => {
  it('resets the password with a single-use emailed token and signs out other sessions', async () => {
    const org = await createOrg();
    const user = await createMember(org);
    await signIn(user);
    const oldCookie = cookieJar.get(COOKIE())!.value;
    signOut();

    expect((await call(forgotRoute, { path: '/x', body: { email: user.email } })).status).toBe(200);
    const url = await lastAccountEmailUrl(user.email, 'password_reset');
    expect(url.pathname).toBe('/reset-password');
    const token = url.searchParams.get('token')!;

    const weak = await call(resetRoute, { path: '/x', body: { token, password: 'short' } });
    expect(weak.status).toBe(422);

    const ok = await call(resetRoute, { path: '/x', body: { token, password: 'A-brand-new-Passphrase-42' } });
    expect(ok.status).toBe(200);
    expect((await login(user.email, TEST_PASSWORD)).status).toBe(401);
    expect((await login(user.email, 'A-brand-new-Passphrase-42')).status).toBe(200);

    // Existing sessions were revoked by the reset.
    cookieJar.set(COOKIE(), oldCookie);
    expect((await me()).status).toBe(401);

    // The token cannot be used twice.
    const replay = await call(resetRoute, { path: '/x', body: { token, password: 'Another-Passphrase-43' } });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('INVALID_TOKEN');
  });

  it('does not reveal whether an account exists', async () => {
    const res = await call(forgotRoute, { path: '/x', body: { email: 'ghost@example.test' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    await expect(lastAccountEmailUrl('ghost@example.test')).rejects.toThrow();
  });
});

describe('sign-up and email verification', () => {
  it('creates an organisation with the founder as admin and verifies their email', async () => {
    const res = await call(signupRoute, {
      path: '/x',
      body: { name: 'Avery Chen', email: 'avery@startup.test', password: 'Launch-Day-Passphrase-1', organizationName: 'Startup Inc', timezone: 'America/Denver' },
    });
    expect(res.status).toBe(201);
    const current = await me();
    expect(current.body).toMatchObject({ role: 'admin', organization: { name: 'Startup Inc' }, user: { emailVerifiedAt: null } });

    const url = await lastAccountEmailUrl('avery@startup.test', 'verify_email');
    expect((await call(verifyRoute, { path: '/x', body: { token: url.searchParams.get('token') } })).status).toBe(200);
    const [row] = await db.select().from(users).where(eq(users.email, 'avery@startup.test'));
    expect(row.emailVerifiedAt).not.toBeNull();
    expect((await call(verifyRoute, { path: '/x', body: { token: url.searchParams.get('token') } })).status).toBe(400);

    const dup = await call(signupRoute, {
      path: '/x',
      body: { name: 'Avery', email: 'avery@startup.test', password: 'Launch-Day-Passphrase-1', organizationName: 'Again', timezone: 'UTC' },
    });
    expect(dup.status).toBe(409);
  });
});

describe('admin creates an interviewer who then signs in (definition of done, steps 1–2)', () => {
  it('invites, accepts, and signs in with the interviewer role', async () => {
    const org = await createOrg();
    const admin = await createMember(org, { role: 'admin' });
    await signIn(admin);
    const invite = await call(inviteRoute, { path: '/x', body: { name: 'Priya Nair', email: 'priya@northwind.test', role: 'interviewer', title: 'Staff Engineer' } });
    expect(invite.status).toBe(201);
    const listed = await call(adminUsersRoute, { path: '/api/admin/users?status=invited' });
    expect(listed.body.items.map((m: { email: string }) => m.email)).toContain('priya@northwind.test');
    signOut();

    const url = await lastAccountEmailUrl('priya@northwind.test', 'invitation');
    const token = url.pathname.split('/').pop()!;
    const accepted = await call(acceptInviteRoute, { path: '/x', body: { token, name: 'Priya Nair', password: 'Interview-Loop-2026', timezone: 'Europe/London' } });
    expect(accepted.status).toBe(200);
    signOut();

    const res = await login('priya@northwind.test', 'Interview-Loop-2026');
    expect(res.status).toBe(200);
    const current = await me();
    expect(current.body).toMatchObject({ role: 'interviewer', organization: { id: org.id }, user: { timezone: 'Europe/London' } });
    expect(current.body.user.emailVerifiedAt).not.toBeNull();

    const audit = await db.select().from(auditLogs).where(eq(auditLogs.organizationId, org.id));
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['user.created', 'user.invitation_accepted', 'auth.login']));
  });
});

describe('role-based access control', () => {
  async function team() {
    const org = await createOrg();
    const admin = await createMember(org, { role: 'admin', name: 'Admin' });
    const recruiter = await createMember(org, { role: 'recruiter', name: 'Recruiter' });
    const alice = await createMember(org, { role: 'interviewer', name: 'Alice' });
    const bob = await createMember(org, { role: 'interviewer', name: 'Bob' });
    const aliceType = await createEventType(org, alice, { slug: 'alice-tech' });
    const bobType = await createEventType(org, bob, { slug: 'bob-tech' });
    await signIn(admin);
    const aliceInterview = await call(createInterviewRoute, {
      path: '/x',
      body: { eventTypeId: aliceType.id, start: upcomingWeekday('America/New_York', '10:00').toISOString(), candidate: { name: 'Cand A', email: 'a@candidate.test', timezone: 'UTC' } },
    });
    const bobInterview = await call(createInterviewRoute, {
      path: '/x',
      body: { eventTypeId: bobType.id, start: upcomingWeekday('America/New_York', '10:00').toISOString(), candidate: { name: 'Cand B', email: 'b@candidate.test', timezone: 'UTC' } },
    });
    signOut();
    return { org, admin, recruiter, alice, bob, aliceType, bobType, aliceInterviewId: aliceInterview.body.interviewId as string, bobInterviewId: bobInterview.body.interviewId as string };
  }

  it('keeps interviewers out of the admin API', async () => {
    const t = await team();
    for (const who of [t.alice, t.recruiter]) {
      await signIn(who);
      expect((await call(adminUsersRoute, { path: '/api/admin/users' })).status).toBe(403);
      expect((await call(auditRoute, { path: '/api/admin/audit-logs' })).status).toBe(403);
      expect((await call(statsRoute, { path: '/api/admin/stats' })).status).toBe(403);
      expect((await call(adminUserRoute, { path: '/x', params: { id: t.bob.id } })).status).toBe(403);
      expect((await call(updateUserRoute, { method: 'PATCH', path: '/x', params: { id: who.id }, body: { role: 'admin' } })).status).toBe(403);
    }
    const [m] = await db.select().from(memberships).where(eq(memberships.userId, t.alice.id));
    expect(m.role).toBe('interviewer');
  });

  it('interviewers only see and manage their own interviews', async () => {
    const t = await team();
    await signIn(t.alice);
    const list = await call(listInterviewsRoute, { path: '/api/interviews?view=all&scope=team' });
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([t.aliceInterviewId]);
    expect((await call(interviewRoute, { path: '/x', params: { id: t.aliceInterviewId } })).status).toBe(200);
    // Another interviewer's interview does not exist as far as Alice can tell.
    expect((await call(interviewRoute, { path: '/x', params: { id: t.bobInterviewId } })).status).toBe(404);
    expect((await call(cancelRoute, { path: '/x', params: { id: t.bobInterviewId }, body: {} })).status).toBe(404);
    // Nor can she book on Bob's event type or edit it.
    const book = await call(createInterviewRoute, {
      path: '/x',
      body: { eventTypeId: t.bobType.id, start: upcomingWeekday('America/New_York', '14:00').toISOString(), candidate: { name: 'X', email: 'x@candidate.test', timezone: 'UTC' } },
    });
    expect(book.status).toBe(403);
    const edit = await call(updateEventTypeRoute, { method: 'PATCH', path: '/x', params: { id: t.bobType.id }, body: validEventType('Hijacked') });
    expect(edit.status).toBe(403);
    // …or create an event type hosted by someone else.
    const create = await call(createEventTypeRoute, {
      path: '/x',
      body: { name: 'Sneaky', durationMinutes: 30, locationType: 'phone', locationDetails: '+1 555 0100', hostUserId: t.bob.id },
    });
    expect(create.status).toBe(403);
    // Only the host can open the Zoom host link.
    expect((await call(zoomStartRoute, { path: '/x', params: { id: t.bobInterviewId } })).status).toBe(404);
  });

  it('recruiters can see and cancel every interview in their organisation', async () => {
    const t = await team();
    await signIn(t.recruiter);
    const list = await call(listInterviewsRoute, { path: '/api/interviews?view=all&scope=team' });
    expect(list.body.total).toBe(2);
    expect((await call(cancelRoute, { path: '/x', params: { id: t.bobInterviewId }, body: { reason: 'Role closed' } })).status).toBe(200);
  });

  it('admins manage roles and deactivation, but cannot lock themselves out', async () => {
    const t = await team();
    await signIn(t.admin);
    expect((await call(updateUserRoute, { method: 'PATCH', path: '/x', params: { id: t.alice.id }, body: { role: 'recruiter' } })).status).toBe(200);
    expect((await call(updateUserRoute, { method: 'PATCH', path: '/x', params: { id: t.admin.id }, body: { role: 'interviewer' } })).status).toBe(403);
    expect((await call(updateUserRoute, { method: 'PATCH', path: '/x', params: { id: t.admin.id }, body: { status: 'deactivated' } })).status).toBe(403);

    // Deactivating Bob ends his sessions immediately.
    signOut();
    await signIn(t.bob);
    const bobCookie = cookieJar.get(COOKIE())!.value;
    signOut();
    await signIn(t.admin);
    expect((await call(updateUserRoute, { method: 'PATCH', path: '/x', params: { id: t.bob.id }, body: { status: 'deactivated' } })).status).toBe(200);
    cookieJar.set(COOKIE(), bobCookie);
    expect((await me()).status).toBe(401);
    expect((await login(t.bob.email, TEST_PASSWORD)).status).toBe(401);

    const details = await (async () => {
      await signIn(t.admin);
      return call(adminUserRoute, { path: '/x', params: { id: t.alice.id } });
    })();
    expect(details.status).toBe(200);
    expect(details.body.member.role).toBe('recruiter');
    expect(details.body.stats).toMatchObject({ total: 1, upcoming: 1 });

    const audit = await db.select().from(auditLogs).where(eq(auditLogs.organizationId, t.org.id));
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['user.role_changed', 'user.deactivated']));
  });

  it('private availability settings belong to their owner only — even admins cannot read or change them', async () => {
    const t = await team();
    await signIn(t.alice);
    const mine = await call(availabilityRoute, { path: '/api/availability' });
    expect(mine.status).toBe(200);
    expect(mine.body.items).toHaveLength(1);
    const aliceSchedule = mine.body.items[0];
    signOut();

    await signIn(t.admin);
    const listed = await call(availabilityRoute, { path: '/api/availability' });
    expect(listed.body.items.map((s: { id: string }) => s.id)).not.toContain(aliceSchedule.id);
    expect((await call(scheduleRoute, { path: '/x', params: { id: aliceSchedule.id } })).status).toBe(404);
    const put = await call(scheduleUpdateRoute, {
      method: 'PUT',
      path: '/x',
      params: { id: aliceSchedule.id },
      body: { name: 'Hijacked', timezone: 'UTC', weekly: [{ weekday: 1, intervals: [{ start: '00:00', end: '23:59' }] }], overrides: [] },
    });
    expect(put.status).toBe(404);
  });
});

describe('tenant isolation', () => {
  it('a user from organisation B can never reach organisation A data', async () => {
    const orgA = await createOrg({ name: 'Org A' });
    const adminA = await createMember(orgA, { role: 'admin' });
    const hostA = await createMember(orgA, { role: 'interviewer' });
    const typeA = await createEventType(orgA, hostA);
    await signIn(adminA);
    const created = await call(createInterviewRoute, {
      path: '/x',
      body: { eventTypeId: typeA.id, start: upcomingWeekday('America/New_York', '10:00').toISOString(), candidate: { name: 'Secret Candidate', email: 'secret@candidate.test', timezone: 'UTC' } },
    });
    signOut();

    const orgB = await createOrg({ name: 'Org B' });
    const adminB: User = await createMember(orgB, { role: 'admin' });
    await signIn(adminB);
    expect((await call(interviewRoute, { path: '/x', params: { id: created.body.interviewId } })).status).toBe(404);
    expect((await call(cancelRoute, { path: '/x', params: { id: created.body.interviewId }, body: {} })).status).toBe(404);
    const list = await call(listInterviewsRoute, { path: '/api/interviews?view=all&scope=team&q=secret' });
    expect(list.body.total).toBe(0);
    expect((await call(adminUserRoute, { path: '/x', params: { id: hostA.id } })).status).toBe(404);
    expect((await call(updateUserRoute, { method: 'PATCH', path: '/x', params: { id: hostA.id }, body: { status: 'deactivated' } })).status).toBe(404);
    expect((await call(updateEventTypeRoute, { method: 'PATCH', path: '/x', params: { id: typeA.id }, body: validEventType('x') })).status).toBe(404);
    expect((await call(updateEventTypeRoute, { method: 'PATCH', path: '/x', params: { id: typeA.id }, body: { isActive: false } })).status).toBe(404);
    const booking = await call(createInterviewRoute, {
      path: '/x',
      body: { eventTypeId: typeA.id, start: upcomingWeekday('America/New_York', '14:00').toISOString(), candidate: { name: 'X', email: 'x@candidate.test', timezone: 'UTC' } },
    });
    expect(booking.status).toBe(404);
    const users = await call(adminUsersRoute, { path: '/api/admin/users' });
    expect(users.body.items.map((m: { userId: string }) => m.userId)).toEqual([adminB.id]);
    const audit = await call(auditRoute, { path: '/api/admin/audit-logs' });
    expect(JSON.stringify(audit.body)).not.toContain('Secret Candidate');
    expect(JSON.stringify(audit.body)).not.toContain(created.body.interviewId);
  });
});
