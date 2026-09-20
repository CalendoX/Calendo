import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST as loginRoute } from '@/app/api/auth/login/route';
import { GET as meRoute } from '@/app/api/auth/me/route';
import { POST as signupRoute } from '@/app/api/auth/signup/route';
import { POST as approveRoute } from '@/app/api/platform/signups/[id]/approve/route';
import { POST as declineRoute } from '@/app/api/platform/signups/[id]/decline/route';
import { GET as listRoute } from '@/app/api/platform/signups/route';
import { resetEnvCache } from '@/server/config/env';
import { db } from '@/server/db/client';
import { auditLogs, organizations, users } from '@/server/db/schema';
import { lastAccountEmailUrl } from '../helpers/db';
import { createMember, createOrg, signIn, signOut, TEST_PASSWORD, type User } from '../helpers/fixtures';
import { call } from '../helpers/http';

const PLATFORM_ADMIN = 'ops@platform.test';
const PASSWORD = 'Launch-Day-Passphrase-1';

beforeEach(() => {
  process.env.PLATFORM_ADMIN_EMAILS = `${PLATFORM_ADMIN}, second-admin@platform.test`;
  resetEnvCache();
});
afterEach(() => {
  delete process.env.PLATFORM_ADMIN_EMAILS;
  resetEnvCache();
});

/** The person running the deployment: listed in PLATFORM_ADMIN_EMAILS, email verified. */
async function platformAdmin(opts: { verified?: boolean } = {}): Promise<User> {
  const org = await createOrg({ name: 'Operator Co' });
  const user = await createMember(org, { role: 'admin', verified: opts.verified });
  const [row] = await db.update(users).set({ email: PLATFORM_ADMIN }).where(eq(users.id, user.id)).returning();
  return row;
}

function signup(email = 'riley@startup.test') {
  return call(signupRoute, {
    path: '/api/auth/signup',
    body: { name: 'Riley Carter', email, password: PASSWORD, organizationName: 'Startup Inc', timezone: 'Europe/London' },
  });
}

const login = (email: string, password = PASSWORD) => call(loginRoute, { path: '/api/auth/login', body: { email, password } });
const pending = (email: string) => db.select().from(users).where(eq(users.email, email)).then(([u]) => u);

describe('sign-up approval', () => {
  it('holds new sign-ups for approval: no session, no sign-in, and platform admins are emailed', async () => {
    const res = await signup();
    expect(res.status).toBe(201);
    expect(res.body.pendingApproval).toBe(true);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await call(meRoute, { path: '/api/auth/me' })).status).toBe(401);

    // Both platform admins get a review link.
    for (const admin of [PLATFORM_ADMIN, 'second-admin@platform.test']) {
      expect((await lastAccountEmailUrl(admin, 'signup_request')).pathname).toBe('/platform/signups');
    }

    // The right password says "waiting for approval"; a wrong one reveals nothing.
    const blocked = await login('riley@startup.test');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('ACCOUNT_PENDING_APPROVAL');
    expect((await login('riley@startup.test', 'Wrong-Password-123')).status).toBe(401);
  });

  it('lets a platform admin approve: the person is emailed and can then sign in as their organization’s admin', async () => {
    const admin = await platformAdmin();
    await signup();
    const person = await pending('riley@startup.test');

    await signIn(admin);
    const list = await call(listRoute, { path: '/api/platform/signups' });
    expect(list.body.items).toEqual([expect.objectContaining({ id: person.id, name: 'Riley Carter', email: 'riley@startup.test', organizationName: 'Startup Inc', emailVerified: false })]);
    expect((await call(approveRoute, { path: '/x', params: { id: person.id }, body: {} })).status).toBe(200);
    expect((await call(listRoute, { path: '/api/platform/signups' })).body.items).toEqual([]);
    expect((await lastAccountEmailUrl('riley@startup.test', 'account_approved')).pathname).toBe('/login');
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, 'user.approved'));
    expect(audit).toMatchObject({ actorUserId: admin.id, resourceId: person.id });
    signOut();

    expect((await login('riley@startup.test')).status).toBe(200);
    expect((await call(meRoute, { path: '/api/auth/me' })).body).toMatchObject({ role: 'admin', organization: { name: 'Startup Inc' } });
  });

  it('declining deletes the pending account and the organization it created, and tells the person', async () => {
    const admin = await platformAdmin();
    await signup();
    const person = await pending('riley@startup.test');

    await signIn(admin);
    expect((await call(declineRoute, { path: '/x', params: { id: person.id }, body: {} })).status).toBe(200);
    signOut();
    expect(await pending('riley@startup.test')).toBeUndefined();
    expect(await db.select().from(organizations).where(eq(organizations.name, 'Startup Inc'))).toHaveLength(0);
    expect((await lastAccountEmailUrl('riley@startup.test', 'signup_declined')).pathname).toBe('/');
    expect((await login('riley@startup.test')).status).toBe(401);
    // The email is free to request access again.
    expect((await signup()).status).toBe(201);
  });

  it('only platform admins with a verified email can review requests', async () => {
    await signup();
    const person = await pending('riley@startup.test');

    const orgAdmin = await createMember(await createOrg(), { role: 'admin' });
    await signIn(orgAdmin);
    expect((await call(listRoute, { path: '/api/platform/signups' })).status).toBe(403);
    expect((await call(approveRoute, { path: '/x', params: { id: person.id }, body: {} })).status).toBe(403);

    // Listed in PLATFORM_ADMIN_EMAILS but the address was never verified: no platform rights.
    await signIn(await platformAdmin({ verified: false }));
    expect((await call(approveRoute, { path: '/x', params: { id: person.id }, body: {} })).status).toBe(403);
    signOut();
    expect((await pending('riley@startup.test')).approvedAt).toBeNull();
  });

  it('does not affect team members, who are approved when created', async () => {
    const member = await createMember(await createOrg(), { role: 'interviewer' });
    expect((await login(member.email, TEST_PASSWORD)).status).toBe(200);
  });
});
