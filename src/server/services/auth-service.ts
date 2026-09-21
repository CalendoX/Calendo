import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { appUrl } from '../config/env';
import { db, type Executor } from '../db/client';
import {
  availabilityRules,
  availabilitySchedules,
  memberships,
  organizations,
  sessions,
  users,
  userTokens,
} from '../db/schema';
import { AppError, BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '../http/errors';
import type { RequestMeta } from '../http/request';
import { enqueue } from '../jobs/queue';
import { QUEUES, type JobPayloads } from '../jobs/definitions';
import { encrypt, hashToken, randomToken } from '../security/crypto';
import { burnPasswordCheck, hashPassword, passwordPolicyError, verifyPassword } from '../auth/password';
import { createSession, revokeAllUserSessions, type AuthContext } from '../auth/session';
import { recordAudit } from './audit';
import { slugify } from '@/lib/format';

/**
 * Account lifecycle: sign-up (creates an organisation and signs the founder in), login with
 * lockout, logout, email verification, password reset, invitations and password changes.
 */

const LOCKOUT_THRESHOLD = 10;
const LOCKOUT_MS = 15 * 60 * 1000;
const TOKEN_TTL = {
  email_verification: 48 * 60 * 60 * 1000,
  password_reset: 60 * 60 * 1000,
  invitation: 7 * 24 * 60 * 60 * 1000,
} as const;

type UserTokenPurpose = keyof typeof TOKEN_TTL;

export async function createUserToken(executor: Executor, userId: string, purpose: UserTokenPurpose, organizationId: string | null = null) {
  const token = randomToken();
  // A new token supersedes any outstanding token of the same purpose.
  await executor
    .update(userTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(userTokens.userId, userId), eq(userTokens.purpose, purpose), isNull(userTokens.usedAt)));
  await executor.insert(userTokens).values({
    userId,
    organizationId,
    purpose,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + TOKEN_TTL[purpose]),
  });
  return token;
}

async function consumeUserToken(executor: Executor, token: string, purpose: UserTokenPurpose) {
  if (!token || token.length > 128) return null;
  const [row] = await executor
    .update(userTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(userTokens.tokenHash, hashToken(token)),
        eq(userTokens.purpose, purpose),
        isNull(userTokens.usedAt),
        gt(userTokens.expiresAt, new Date()),
      ),
    )
    .returning();
  return row ?? null;
}

export async function peekUserToken(token: string, purpose: UserTokenPurpose) {
  if (!token || token.length > 128) return null;
  const [row] = await db
    .select({ token: userTokens, user: users, organization: organizations })
    .from(userTokens)
    .innerJoin(users, eq(users.id, userTokens.userId))
    .leftJoin(organizations, eq(organizations.id, userTokens.organizationId))
    .where(
      and(
        eq(userTokens.tokenHash, hashToken(token)),
        eq(userTokens.purpose, purpose),
        isNull(userTokens.usedAt),
        gt(userTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function uniqueUsername(base: string, executor: Executor = db): Promise<string> {
  let root = slugify(base).replace(/[^a-z0-9-]/g, '').slice(0, 30);
  if (root.length < 3) root = `${root}user`.slice(0, 30);
  root = root.replace(/^-+|-+$/g, '') || 'user';
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const [exists] = await executor.select({ id: users.id }).from(users).where(eq(users.username, candidate)).limit(1);
    if (!exists) return candidate;
  }
  return `${root}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

async function uniqueOrgSlug(base: string, executor: Executor): Promise<string> {
  const root = slugify(base) || 'team';
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const [exists] = await executor.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, candidate)).limit(1);
    if (!exists) return candidate;
  }
  return `${root}-${randomToken(4).toLowerCase()}`;
}

/** Creates the Mon–Fri 09:00–17:00 default schedule every new member starts with. */
export async function createDefaultSchedule(executor: Executor, userId: string, organizationId: string, timezone: string) {
  const [schedule] = await executor
    .insert(availabilitySchedules)
    .values({ organizationId, userId, name: 'Working hours', timezone, isDefault: true })
    .returning();
  await executor.insert(availabilityRules).values(
    [1, 2, 3, 4, 5].map((weekday) => ({ scheduleId: schedule.id, weekday, startMinute: 9 * 60, endMinute: 17 * 60 })),
  );
  return schedule;
}

export async function sendAccountEmail(
  kind: JobPayloads['account-email']['kind'],
  to: string,
  name: string,
  url: string,
  extra: { organizationName?: string; inviterName?: string } = {},
) {
  await enqueue(QUEUES.accountEmail, { kind, to, name, encryptedUrl: encrypt(url), ...extra });
}

// ---------------------------------------------------------------------------------------------

export interface SignupInput {
  name: string;
  email: string;
  password: string;
  organizationName: string;
  timezone: string;
}

export async function signup(input: SignupInput, meta: RequestMeta) {
  const email = input.email.trim().toLowerCase();
  const policy = passwordPolicyError(input.password, { email });
  if (policy) throw new ValidationError(policy, { password: [policy] });
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) throw new ConflictError('An account with this email already exists. Try signing in instead.', 'EMAIL_TAKEN');

  const passwordHash = await hashPassword(input.password);
  const result = await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({
        name: input.organizationName.trim(),
        slug: await uniqueOrgSlug(input.organizationName, tx),
        defaultTimezone: input.timezone,
        settings: { reminderOffsetsMinutes: [1440, 60], candidateCanReschedule: true, candidateCanCancel: true, candidateManageCutoffMinutes: 60 },
      })
      .returning();
    const [user] = await tx
      .insert(users)
      .values({
        email,
        name: input.name.trim(),
        username: await uniqueUsername(input.name || email.split('@')[0], tx),
        passwordHash,
        timezone: input.timezone,
        // A second in the past, so the session created below outlives this "password change".
        passwordChangedAt: new Date(Date.now() - 1000),
      })
      .returning();
    await tx.insert(memberships).values({ organizationId: org.id, userId: user.id, role: 'admin', status: 'active' });
    await createDefaultSchedule(tx, user.id, org.id, input.timezone);
    const verifyToken = await createUserToken(tx, user.id, 'email_verification');
    await recordAudit(
      { organizationId: org.id, actor: { type: 'user', userId: user.id }, action: 'organization.created', resourceType: 'organization', resourceId: org.id, metadata: { name: org.name }, meta },
      tx,
    );
    await recordAudit(
      { organizationId: org.id, actor: { type: 'user', userId: user.id }, action: 'user.created', resourceType: 'user', resourceId: user.id, metadata: { email, role: 'admin', via: 'signup' }, meta },
      tx,
    );
    return { org, user, verifyToken };
  });
  await sendAccountEmail('verify_email', email, result.user.name, appUrl(`/verify-email?token=${result.verifyToken}`));
  // Sign-up is self-service: the founder is signed in to their new organisation straight away and
  // verifies their email from inside the app (unverified accounts can't publish booking pages).
  const session = await createSession(result.user.id, result.org.id, meta);
  return { user: result.user, organization: result.org, session };
}

export async function login(emailInput: string, password: string, meta: RequestMeta) {
  const email = emailInput.trim().toLowerCase();
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const invalid = new UnauthorizedError('Incorrect email or password.');
  if (!user || !user.passwordHash) {
    await burnPasswordCheck(password);
    throw invalid;
  }
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
    throw new AppError(429, 'ACCOUNT_LOCKED', `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'} or reset your password.`);
  }
  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) {
    const attempts = user.failedLoginAttempts + 1;
    const lock = attempts >= LOCKOUT_THRESHOLD;
    await db
      .update(users)
      .set({ failedLoginAttempts: lock ? 0 : attempts, lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MS) : user.lockedUntil })
      .where(eq(users.id, user.id));
    await recordAudit({ organizationId: null, actor: { type: 'user', userId: user.id }, action: 'auth.login_failed', resourceType: 'user', resourceId: user.id, metadata: { locked: lock }, meta });
    throw invalid;
  }
  if (user.status !== 'active') throw new UnauthorizedError('This account has been deactivated. Contact your administrator.');
  const active = await db
    .select({ organizationId: memberships.organizationId })
    .from(memberships)
    .where(and(eq(memberships.userId, user.id), eq(memberships.status, 'active')))
    .orderBy(memberships.createdAt);
  if (active.length === 0) throw new UnauthorizedError('Your access has been deactivated. Contact your administrator.');

  await db.update(users).set({ failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(users.id, user.id));
  const session = await createSession(user.id, active[0].organizationId, meta);
  await recordAudit({ organizationId: active[0].organizationId, actor: { type: 'user', userId: user.id }, action: 'auth.login', resourceType: 'user', resourceId: user.id, meta });
  return { user, session };
}

export async function logout(ctx: AuthContext, meta: RequestMeta) {
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, ctx.sessionId));
  await recordAudit({ organizationId: ctx.organization.id, actor: { type: 'user', userId: ctx.user.id }, action: 'auth.logout', resourceType: 'user', resourceId: ctx.user.id, meta });
}

/** Tells the caller when no usable account matches, so a mistyped address can be corrected. */
export async function requestPasswordReset(emailInput: string, meta: RequestMeta) {
  const email = emailInput.trim().toLowerCase();
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) throw new NotFoundError('No account is registered with this email address.');
  if (user.status !== 'active') throw new ForbiddenError('This account has been deactivated. Contact your administrator.');
  const token = await createUserToken(db, user.id, 'password_reset');
  await sendAccountEmail('password_reset', user.email, user.name, appUrl(`/reset-password?token=${token}`));
  await recordAudit({ organizationId: null, actor: { type: 'user', userId: user.id }, action: 'auth.password_reset_requested', resourceType: 'user', resourceId: user.id, meta });
}

export async function resetPassword(token: string, newPassword: string, meta: RequestMeta) {
  const preview = await peekUserToken(token, 'password_reset');
  if (!preview) throw new BadRequestError('This reset link is invalid or has expired. Request a new one.', 'INVALID_TOKEN');
  const policy = passwordPolicyError(newPassword, { email: preview.user.email });
  if (policy) throw new ValidationError(policy, { password: [policy] });
  const passwordHash = await hashPassword(newPassword);
  const userId = await db.transaction(async (tx) => {
    const row = await consumeUserToken(tx, token, 'password_reset');
    if (!row) throw new BadRequestError('This reset link is invalid or has expired. Request a new one.', 'INVALID_TOKEN');
    await tx
      .update(users)
      .set({
        passwordHash,
        passwordChangedAt: new Date(),
        failedLoginAttempts: 0,
        lockedUntil: null,
        // Receiving the email proves ownership of the address.
        emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, row.userId));
    return row.userId;
  });
  await revokeAllUserSessions(userId);
  await recordAudit({ organizationId: null, actor: { type: 'user', userId }, action: 'auth.password_reset', resourceType: 'user', resourceId: userId, meta });
}

export async function verifyEmail(token: string, meta: RequestMeta) {
  const row = await consumeUserToken(db, token, 'email_verification');
  if (!row) throw new BadRequestError('This verification link is invalid or has expired.', 'INVALID_TOKEN');
  await db.update(users).set({ emailVerifiedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, row.userId));
  await recordAudit({ organizationId: null, actor: { type: 'user', userId: row.userId }, action: 'auth.email_verified', resourceType: 'user', resourceId: row.userId, meta });
}

export async function resendVerification(ctx: AuthContext) {
  if (ctx.user.emailVerifiedAt) return;
  const token = await createUserToken(db, ctx.user.id, 'email_verification');
  await sendAccountEmail('verify_email', ctx.user.email, ctx.user.name, appUrl(`/verify-email?token=${token}`));
}

export async function sendInvitationEmail(userId: string, organizationId: string, inviterName: string) {
  const [row] = await db
    .select({ user: users, org: organizations })
    .from(users)
    .innerJoin(organizations, eq(organizations.id, organizationId))
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return null;
  const token = await createUserToken(db, userId, 'invitation', organizationId);
  const url = appUrl(`/invite/${token}`);
  await sendAccountEmail('invitation', row.user.email, row.user.name, url, { organizationName: row.org.name, inviterName });
  return url;
}

export async function acceptInvitation(token: string, input: { name: string; password: string; timezone: string }, meta: RequestMeta) {
  const preview = await peekUserToken(token, 'invitation');
  if (!preview || !preview.token.organizationId) {
    throw new BadRequestError('This invitation is invalid or has expired. Ask your administrator to resend it.', 'INVALID_TOKEN');
  }
  const policy = passwordPolicyError(input.password, { email: preview.user.email });
  if (policy) throw new ValidationError(policy, { password: [policy] });
  const passwordHash = await hashPassword(input.password);
  const organizationId = preview.token.organizationId;
  const user = await db.transaction(async (tx) => {
    const row = await consumeUserToken(tx, token, 'invitation');
    if (!row) throw new BadRequestError('This invitation is invalid or has expired.', 'INVALID_TOKEN');
    const [u] = await tx
      .update(users)
      .set({
        name: input.name.trim() || preview.user.name,
        passwordHash,
        passwordChangedAt: new Date(Date.now() - 1000),
        timezone: input.timezone,
        emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, row.userId))
      .returning();
    await tx
      .update(memberships)
      .set({ status: 'active', updatedAt: new Date() })
      .where(and(eq(memberships.userId, row.userId), eq(memberships.organizationId, organizationId), eq(memberships.status, 'invited')));
    await tx
      .update(availabilitySchedules)
      .set({ timezone: input.timezone })
      .where(and(eq(availabilitySchedules.userId, row.userId), eq(availabilitySchedules.isDefault, true)));
    await recordAudit(
      { organizationId, actor: { type: 'user', userId: row.userId }, action: 'user.invitation_accepted', resourceType: 'user', resourceId: row.userId, meta },
      tx,
    );
    return u;
  });
  const session = await createSession(user.id, organizationId, meta);
  return { user, session };
}

export async function changePassword(ctx: AuthContext, currentPassword: string, newPassword: string, meta: RequestMeta) {
  const [user] = await db.select().from(users).where(eq(users.id, ctx.user.id)).limit(1);
  if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, currentPassword))) {
    throw new ValidationError('Current password is incorrect.', { currentPassword: ['Current password is incorrect.'] });
  }
  const policy = passwordPolicyError(newPassword, { email: user.email });
  if (policy) throw new ValidationError(policy, { newPassword: [policy] });
  // Keep the current session valid; revoke all others.
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() })
    .where(eq(users.id, user.id));
  await revokeAllUserSessions(user.id, ctx.sessionId);
  await recordAudit({ organizationId: ctx.organization.id, actor: { type: 'user', userId: user.id }, action: 'auth.password_changed', resourceType: 'user', resourceId: user.id, meta });
}
