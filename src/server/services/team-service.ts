import { and, count, desc, eq, gt, ilike, inArray, or, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/session';
import { requireAdmin, canChangeRole } from '../authz/policy';
import { db } from '../db/client';
import {
  auditLogs,
  eventTypes,
  integrations,
  interviews,
  memberships,
  sessions,
  users,
  type MembershipRole,
} from '../db/schema';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../http/errors';
import type { RequestMeta } from '../http/request';
import { recordAudit } from './audit';
import { createDefaultSchedule, sendInvitationEmail, uniqueUsername } from './auth-service';

/** Organisation membership management (admin) and the team directory (everyone). */

export interface MemberSummary {
  userId: string;
  membershipId: string;
  name: string;
  email: string;
  username: string;
  title: string | null;
  timezone: string;
  role: MembershipRole;
  status: 'active' | 'invited' | 'deactivated';
  emailVerified: boolean;
  lastLoginAt: string | null;
  joinedAt: string;
  integrations: { provider: string; status: string }[];
  upcomingInterviews: number;
  totalInterviews: number;
  eventTypes: number;
}

export async function listMembers(ctx: AuthContext, opts: { search?: string; role?: MembershipRole; status?: string } = {}): Promise<MemberSummary[]> {
  const conditions = [eq(memberships.organizationId, ctx.organization.id)];
  if (opts.search) {
    const q = `%${opts.search.replace(/[%_]/g, '\\$&')}%`;
    conditions.push(or(ilike(users.name, q), ilike(users.email, q))!);
  }
  if (opts.role) conditions.push(eq(memberships.role, opts.role));
  if (opts.status === 'active' || opts.status === 'invited' || opts.status === 'deactivated') conditions.push(eq(memberships.status, opts.status));
  // Non-admins only see active teammates.
  if (ctx.membership.role !== 'admin') conditions.push(eq(memberships.status, 'active'));

  const rows = await db
    .select({ membership: memberships, user: users })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(...conditions))
    .orderBy(users.name);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.user.id);

  const [integrationRows, interviewCounts, eventTypeCounts] = await Promise.all([
    db
      .select({ userId: integrations.userId, provider: integrations.provider, status: integrations.status })
      .from(integrations)
      .where(and(inArray(integrations.userId, ids), eq(integrations.organizationId, ctx.organization.id))),
    db
      .select({
        hostUserId: interviews.hostUserId,
        total: count(),
        upcoming: sql<number>`count(*) filter (where ${interviews.startAt} > now() and ${interviews.status} in ('scheduled','rescheduled'))`,
      })
      .from(interviews)
      .where(and(eq(interviews.organizationId, ctx.organization.id), inArray(interviews.hostUserId, ids)))
      .groupBy(interviews.hostUserId),
    db
      .select({ hostUserId: eventTypes.hostUserId, total: count() })
      .from(eventTypes)
      .where(and(eq(eventTypes.organizationId, ctx.organization.id), inArray(eventTypes.hostUserId, ids), sql`${eventTypes.deletedAt} is null`))
      .groupBy(eventTypes.hostUserId),
  ]);

  return rows.map(({ membership, user }) => {
    const ic = interviewCounts.find((c) => c.hostUserId === user.id);
    return {
      userId: user.id,
      membershipId: membership.id,
      name: user.name,
      email: user.email,
      username: user.username,
      title: user.title,
      timezone: user.timezone,
      role: membership.role,
      status: user.status === 'deactivated' ? 'deactivated' : membership.status,
      emailVerified: Boolean(user.emailVerifiedAt),
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      joinedAt: membership.createdAt.toISOString(),
      integrations: integrationRows.filter((i) => i.userId === user.id).map((i) => ({ provider: i.provider, status: i.status })),
      upcomingInterviews: Number(ic?.upcoming ?? 0),
      totalInterviews: Number(ic?.total ?? 0),
      eventTypes: Number(eventTypeCounts.find((c) => c.hostUserId === user.id)?.total ?? 0),
    };
  });
}

export async function getMemberDetails(ctx: AuthContext, userId: string) {
  requireAdmin(ctx);
  const [member] = (await listMembers(ctx)).filter((m) => m.userId === userId);
  if (!member) throw new NotFoundError('User not found');
  const [stats] = await db
    .select({
      total: count(),
      completed: sql<number>`count(*) filter (where ${interviews.status} = 'completed')`,
      cancelled: sql<number>`count(*) filter (where ${interviews.status} = 'cancelled')`,
      noShow: sql<number>`count(*) filter (where ${interviews.status} = 'no_show')`,
      rescheduled: sql<number>`count(*) filter (where ${interviews.rescheduleCount} > 0)`,
      upcoming: sql<number>`count(*) filter (where ${interviews.startAt} > now() and ${interviews.status} in ('scheduled','rescheduled'))`,
    })
    .from(interviews)
    .where(and(eq(interviews.organizationId, ctx.organization.id), eq(interviews.hostUserId, userId)));
  const integrationRows = await db
    .select({
      provider: integrations.provider,
      status: integrations.status,
      accountEmail: integrations.externalAccountEmail,
      connectedAt: integrations.connectedAt,
      lastError: integrations.lastError,
    })
    .from(integrations)
    .where(and(eq(integrations.userId, userId), eq(integrations.organizationId, ctx.organization.id)));
  const types = await db
    .select({ id: eventTypes.id, name: eventTypes.name, slug: eventTypes.slug, isActive: eventTypes.isActive, durationMinutes: eventTypes.durationMinutes })
    .from(eventTypes)
    .where(and(eq(eventTypes.organizationId, ctx.organization.id), eq(eventTypes.hostUserId, userId), sql`${eventTypes.deletedAt} is null`));
  const activity = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.organizationId, ctx.organization.id), or(eq(auditLogs.actorUserId, userId), and(eq(auditLogs.resourceType, 'user'), eq(auditLogs.resourceId, userId)))))
    .orderBy(desc(auditLogs.createdAt))
    .limit(15);
  return {
    member,
    stats: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, Number(v)])) as Record<keyof typeof stats, number>,
    integrations: integrationRows.map((i) => ({ ...i, connectedAt: i.connectedAt.toISOString() })),
    eventTypes: types,
    activity,
  };
}

export async function inviteMember(
  ctx: AuthContext,
  input: { name: string; email: string; role: MembershipRole; title?: string | null },
  meta: RequestMeta,
) {
  requireAdmin(ctx);
  const email = input.email.trim().toLowerCase();
  const [existingUser] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existingUser) {
    const [existingMembership] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, existingUser.id), eq(memberships.organizationId, ctx.organization.id)))
      .limit(1);
    if (existingMembership) throw new ConflictError('This person is already a member of your organization.', 'ALREADY_MEMBER');
  }

  const result = await db.transaction(async (tx) => {
    let userId: string;
    let invited = false;
    if (existingUser) {
      userId = existingUser.id;
      await tx.insert(memberships).values({
        organizationId: ctx.organization.id,
        userId,
        role: input.role,
        status: existingUser.passwordHash ? 'active' : 'invited',
        invitedById: ctx.user.id,
      });
      invited = !existingUser.passwordHash;
    } else {
      const [u] = await tx
        .insert(users)
        .values({
          email,
          name: input.name.trim(),
          title: input.title?.trim() || null,
          username: await uniqueUsername(input.name || email.split('@')[0], tx),
          timezone: ctx.organization.defaultTimezone,
        })
        .returning();
      userId = u.id;
      invited = true;
      await tx.insert(memberships).values({
        organizationId: ctx.organization.id,
        userId,
        role: input.role,
        status: 'invited',
        invitedById: ctx.user.id,
      });
    }
    await createDefaultSchedule(tx, userId, ctx.organization.id, existingUser?.timezone ?? ctx.organization.defaultTimezone);
    await recordAudit(
      {
        organizationId: ctx.organization.id,
        actor: { type: 'user', userId: ctx.user.id },
        action: existingUser ? 'user.invited' : 'user.created',
        resourceType: 'user',
        resourceId: userId,
        metadata: { email, role: input.role, invited },
        meta,
      },
      tx,
    );
    return { userId, invited };
  });
  const inviteUrl = result.invited ? await sendInvitationEmail(result.userId, ctx.organization.id, ctx.user.name) : null;
  return { userId: result.userId, inviteUrl };
}

export async function resendInvitation(ctx: AuthContext, userId: string) {
  requireAdmin(ctx);
  const [m] = await db
    .select({ membership: memberships })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, ctx.organization.id)))
    .limit(1);
  if (!m) throw new NotFoundError('User not found');
  if (m.membership.status !== 'invited') throw new BadRequestError('This user has already accepted their invitation.');
  return { inviteUrl: await sendInvitationEmail(userId, ctx.organization.id, ctx.user.name) };
}

async function activeAdminCount(organizationId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(memberships)
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.role, 'admin'), eq(memberships.status, 'active')));
  return Number(row?.n ?? 0);
}

export async function updateMember(
  ctx: AuthContext,
  userId: string,
  input: { role?: MembershipRole; status?: 'active' | 'deactivated'; title?: string | null },
  meta: RequestMeta,
) {
  requireAdmin(ctx);
  const [row] = await db
    .select({ membership: memberships, user: users })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, ctx.organization.id)))
    .limit(1);
  if (!row) throw new NotFoundError('User not found');
  const { membership } = row;

  if (input.role && input.role !== membership.role) {
    if (!canChangeRole(ctx, { userId }, input.role)) throw new ForbiddenError('You cannot remove your own administrator role.');
    if (membership.role === 'admin' && (await activeAdminCount(ctx.organization.id)) <= 1) {
      throw new BadRequestError('An organization must have at least one active administrator.', 'LAST_ADMIN');
    }
    await db.update(memberships).set({ role: input.role, updatedAt: new Date() }).where(eq(memberships.id, membership.id));
    await recordAudit({
      organizationId: ctx.organization.id,
      actor: { type: 'user', userId: ctx.user.id },
      action: 'user.role_changed',
      resourceType: 'user',
      resourceId: userId,
      metadata: { from: membership.role, to: input.role, email: row.user.email },
      meta,
    });
  }

  if (input.status && input.status !== membership.status) {
    if (userId === ctx.user.id) throw new ForbiddenError('You cannot deactivate your own account.');
    if (input.status === 'deactivated') {
      if (membership.role === 'admin' && (await activeAdminCount(ctx.organization.id)) <= 1) {
        throw new BadRequestError('An organization must have at least one active administrator.', 'LAST_ADMIN');
      }
      await db.update(memberships).set({ status: 'deactivated', updatedAt: new Date() }).where(eq(memberships.id, membership.id));
      // End their sessions in this organisation immediately.
      await db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, userId), eq(sessions.activeOrganizationId, ctx.organization.id), sql`${sessions.revokedAt} is null`));
      await recordAudit({
        organizationId: ctx.organization.id,
        actor: { type: 'user', userId: ctx.user.id },
        action: 'user.deactivated',
        resourceType: 'user',
        resourceId: userId,
        metadata: { email: row.user.email },
        meta,
      });
    } else {
      const status = row.user.passwordHash ? 'active' : 'invited';
      await db.update(memberships).set({ status, updatedAt: new Date() }).where(eq(memberships.id, membership.id));
      await recordAudit({
        organizationId: ctx.organization.id,
        actor: { type: 'user', userId: ctx.user.id },
        action: 'user.activated',
        resourceType: 'user',
        resourceId: userId,
        metadata: { email: row.user.email },
        meta,
      });
    }
  }

  if (input.title !== undefined) {
    await db.update(users).set({ title: input.title?.trim() || null, updatedAt: new Date() }).where(eq(users.id, userId));
  }
}

/** Upcoming interview counts for the next 7 days, used in team views. */
export async function upcomingLoad(organizationId: string) {
  return db
    .select({ hostUserId: interviews.hostUserId, n: count() })
    .from(interviews)
    .where(
      and(
        eq(interviews.organizationId, organizationId),
        inArray(interviews.status, ['scheduled', 'rescheduled']),
        gt(interviews.startAt, new Date()),
        sql`${interviews.startAt} < now() + interval '7 days'`,
      ),
    )
    .groupBy(interviews.hostUserId);
}
