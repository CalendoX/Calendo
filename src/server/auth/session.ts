import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { appUrl } from '../config/env';
import { db } from '../db/client';
import {
  memberships,
  organizations,
  sessions,
  users,
  type MembershipRole,
  type OrganizationSettings,
} from '../db/schema';
import { hashToken, randomToken } from '../security/crypto';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // absolute lifetime
export const SESSION_IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // inactivity expiry
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  username: string;
  timezone: string;
  title: string | null;
  emailVerifiedAt: Date | null;
}

export interface SessionOrganization {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  brandColor: string;
  defaultTimezone: string;
  settings: OrganizationSettings;
}

export interface AuthContext {
  sessionId: string;
  user: SessionUser;
  organization: SessionOrganization;
  membership: { id: string; role: MembershipRole };
  memberships: { organizationId: string; organizationName: string; role: MembershipRole }[];
}

export function isSecureCookieContext() {
  return appUrl().startsWith('https://');
}

export function sessionCookieName() {
  // The __Host- prefix pins the cookie to this exact origin (Secure, Path=/, no Domain).
  return isSecureCookieContext() ? '__Host-slate_session' : 'slate_session';
}

export async function createSession(
  userId: string,
  organizationId: string | null,
  meta: { ip: string | null; userAgent: string | null },
) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const [row] = await db
    .insert(sessions)
    .values({
      tokenHash: hashToken(token),
      userId,
      activeOrganizationId: organizationId,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
      expiresAt,
    })
    .returning({ id: sessions.id });
  return { token, expiresAt, sessionId: row.id };
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  const jar = await cookies();
  jar.set(sessionCookieName(), token, {
    httpOnly: true,
    secure: isSecureCookieContext(),
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.set(sessionCookieName(), '', {
    httpOnly: true,
    secure: isSecureCookieContext(),
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

export async function revokeSession(sessionId: string) {
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
}

export async function revokeAllUserSessions(userId: string, exceptSessionId?: string) {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        exceptSessionId ? ne(sessions.id, exceptSessionId) : undefined,
      ),
    );
}

/** Resolves a raw session token into an authenticated, organisation-scoped context. */
export async function resolveSessionToken(token: string): Promise<AuthContext | null> {
  if (!token || token.length > 128) return null;
  const now = new Date();
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
    .limit(1);
  if (!row) return null;
  const { session, user } = row;
  if (user.status !== 'active') return null;
  if (now.getTime() - session.lastSeenAt.getTime() > SESSION_IDLE_TIMEOUT_MS) return null;
  // Sessions issued before a password change are invalid.
  if (user.passwordChangedAt && session.createdAt < user.passwordChangedAt) return null;

  const memberRows = await db
    .select({ membership: memberships, organization: organizations })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(and(eq(memberships.userId, user.id), eq(memberships.status, 'active')));
  if (memberRows.length === 0) return null;

  const active =
    memberRows.find((m) => m.organization.id === session.activeOrganizationId) ??
    memberRows.sort((a, b) => a.membership.createdAt.getTime() - b.membership.createdAt.getTime())[0];

  if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS || active.organization.id !== session.activeOrganizationId) {
    await db
      .update(sessions)
      .set({ lastSeenAt: now, activeOrganizationId: active.organization.id })
      .where(eq(sessions.id, session.id));
  }

  return {
    sessionId: session.id,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      username: user.username,
      timezone: user.timezone,
      title: user.title,
      emailVerifiedAt: user.emailVerifiedAt,
    },
    organization: {
      id: active.organization.id,
      name: active.organization.name,
      slug: active.organization.slug,
      logoUrl: active.organization.logoUrl,
      brandColor: active.organization.brandColor,
      defaultTimezone: active.organization.defaultTimezone,
      settings: active.organization.settings,
    },
    membership: { id: active.membership.id, role: active.membership.role },
    memberships: memberRows.map((m) => ({
      organizationId: m.organization.id,
      organizationName: m.organization.name,
      role: m.membership.role,
    })),
  };
}

/** Current auth context for server components / route handlers (memoised per request). */
export const getAuth = cache(async (): Promise<AuthContext | null> => {
  const jar = await cookies();
  const token = jar.get(sessionCookieName())?.value;
  if (!token) return null;
  return resolveSessionToken(token);
});

export async function switchOrganization(sessionId: string, userId: string, organizationId: string) {
  const [m] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, organizationId), eq(memberships.status, 'active')))
    .limit(1);
  if (!m) return false;
  await db.update(sessions).set({ activeOrganizationId: organizationId }).where(eq(sessions.id, sessionId));
  return true;
}
