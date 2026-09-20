import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm';
import type { AuthContext } from '../auth/session';
import { requirePlatformAdmin } from '../authz/policy';
import { appUrl } from '../config/env';
import { db } from '../db/client';
import { memberships, organizations, users } from '../db/schema';
import { NotFoundError } from '../http/errors';
import type { RequestMeta } from '../http/request';
import { recordAudit } from './audit';
import { sendAccountEmail } from './auth-service';

/**
 * Self-service sign-ups (each creating a new organisation) wait for a platform admin. Until then
 * the account cannot sign in; declining removes the account and the organisation it created.
 */

export interface SignupRequest {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  organizationName: string | null;
  requestedAt: string;
}

export async function listSignupRequests(ctx: AuthContext): Promise<SignupRequest[]> {
  requirePlatformAdmin(ctx);
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, emailVerifiedAt: users.emailVerifiedAt, createdAt: users.createdAt, organizationName: organizations.name })
    .from(users)
    .leftJoin(memberships, eq(memberships.userId, users.id))
    .leftJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(isNull(users.approvedAt))
    .orderBy(asc(users.createdAt));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    emailVerified: Boolean(r.emailVerifiedAt),
    organizationName: r.organizationName,
    requestedAt: r.createdAt.toISOString(),
  }));
}

export async function countSignupRequests(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(users).where(isNull(users.approvedAt));
  return row?.n ?? 0;
}

async function organizationsOf(userId: string) {
  return db
    .select({ id: organizations.id, name: organizations.name })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(eq(memberships.userId, userId));
}

export async function approveSignup(ctx: AuthContext, userId: string, meta: RequestMeta) {
  requirePlatformAdmin(ctx);
  const [user] = await db
    .update(users)
    .set({ approvedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(users.id, userId), isNull(users.approvedAt)))
    .returning();
  if (!user) throw new NotFoundError('This sign-up request no longer exists.');
  const [org] = await organizationsOf(user.id);
  await recordAudit({
    organizationId: org?.id ?? null,
    actor: { type: 'user', userId: ctx.user.id },
    action: 'user.approved',
    resourceType: 'user',
    resourceId: user.id,
    metadata: { email: user.email, approvedBy: ctx.user.email },
    meta,
  });
  await sendAccountEmail('account_approved', user.email, user.name, appUrl('/login'), { organizationName: org?.name });
}

export async function declineSignup(ctx: AuthContext, userId: string, meta: RequestMeta) {
  requirePlatformAdmin(ctx);
  const declined = await db.transaction(async (tx) => {
    const [user] = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.approvedAt)))
      .for('update');
    if (!user) return null;
    const orgs = await tx
      .select({ id: organizations.id, name: organizations.name, members: count(memberships.id) })
      .from(organizations)
      .innerJoin(memberships, eq(memberships.organizationId, organizations.id))
      .where(inArray(organizations.id, tx.select({ id: memberships.organizationId }).from(memberships).where(eq(memberships.userId, user.id))))
      .groupBy(organizations.id);
    // Only organisations this sign-up created (nobody else in them) go with it.
    const own = orgs.filter((o) => o.members === 1).map((o) => o.id);
    if (own.length) await tx.delete(organizations).where(inArray(organizations.id, own));
    await tx.delete(users).where(eq(users.id, user.id));
    return { user, organizationName: orgs[0]?.name ?? null };
  });
  if (!declined) throw new NotFoundError('This sign-up request no longer exists.');
  await recordAudit({
    organizationId: null,
    actor: { type: 'user', userId: ctx.user.id },
    action: 'user.signup_declined',
    resourceType: 'user',
    resourceId: declined.user.id,
    metadata: { email: declined.user.email, organization: declined.organizationName, declinedBy: ctx.user.email },
    meta,
  });
  await sendAccountEmail('signup_declined', declined.user.email, declined.user.name, appUrl('/'), {
    organizationName: declined.organizationName ?? undefined,
  });
}
