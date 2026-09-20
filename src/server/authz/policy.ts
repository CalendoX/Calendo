import type { AuthContext } from '../auth/session';
import type { MembershipRole } from '../db/schema';
import { platformAdminEmails } from '../config/env';
import { ForbiddenError, NotFoundError } from '../http/errors';

/**
 * Role-based access control. All checks are organisation-scoped: a resource from another
 * organisation is reported as "not found" so its existence is never revealed.
 *
 * Roles
 *  - admin:        full control of the organisation (users, settings, every interview, audit log)
 *  - recruiter:    manages their own event types/availability/integrations, and can view and
 *                  manage (reschedule / cancel) every interview in the organisation
 *  - interviewer:  manages their own event types/availability/integrations and interviews only
 *
 * Private settings (availability, integrations, profile) are only ever accessible to their
 * owner — admins can see integration *status* but never credentials.
 */

export const ROLE_LABELS: Record<MembershipRole, string> = {
  admin: 'Admin',
  recruiter: 'Recruiter',
  interviewer: 'Interviewer',
};

/**
 * Platform admins run this Calendor deployment (PLATFORM_ADMIN_EMAILS) and approve new sign-ups.
 * The address must be verified, so a listed email that someone else registers first grants nothing.
 */
export function isPlatformAdmin(ctx: AuthContext) {
  return Boolean(ctx.user.emailVerifiedAt) && platformAdminEmails().includes(ctx.user.email.toLowerCase());
}

export function requirePlatformAdmin(ctx: AuthContext) {
  if (!isPlatformAdmin(ctx)) throw new ForbiddenError();
}

export function isAdmin(ctx: AuthContext) {
  return ctx.membership.role === 'admin';
}

export function requireAdmin(ctx: AuthContext) {
  if (!isAdmin(ctx)) throw new ForbiddenError('Administrator access required');
}

/** Throws NotFound unless the resource belongs to the caller's organisation. */
export function assertSameOrganization(ctx: AuthContext, organizationId: string | null | undefined): asserts organizationId {
  if (!organizationId || organizationId !== ctx.organization.id) throw new NotFoundError();
}

/** Whether the caller can see every interview in the organisation (vs only their own). */
export function canViewAllInterviews(ctx: AuthContext) {
  return ctx.membership.role === 'admin' || ctx.membership.role === 'recruiter';
}

export function canViewInterview(ctx: AuthContext, interview: { organizationId: string; hostUserId: string }) {
  if (interview.organizationId !== ctx.organization.id) return false;
  return canViewAllInterviews(ctx) || interview.hostUserId === ctx.user.id;
}

export function assertCanViewInterview(ctx: AuthContext, interview: { organizationId: string; hostUserId: string }) {
  if (!canViewInterview(ctx, interview)) throw new NotFoundError('Interview not found');
}

/** Reschedule / cancel / status changes / integration retries. */
export function assertCanManageInterview(ctx: AuthContext, interview: { organizationId: string; hostUserId: string }) {
  assertCanViewInterview(ctx, interview);
}

export function canManageEventType(ctx: AuthContext, eventType: { organizationId: string; hostUserId: string }) {
  if (eventType.organizationId !== ctx.organization.id) return false;
  return isAdmin(ctx) || eventType.hostUserId === ctx.user.id;
}

export function assertCanManageEventType(ctx: AuthContext, eventType: { organizationId: string; hostUserId: string }) {
  if (eventType.organizationId !== ctx.organization.id) throw new NotFoundError('Event type not found');
  if (!canManageEventType(ctx, eventType)) throw new ForbiddenError('You can only manage your own event types');
}

/** Admins may create event types on behalf of any member; others only for themselves. */
export function assertCanAssignHost(ctx: AuthContext, hostUserId: string) {
  if (hostUserId !== ctx.user.id && !isAdmin(ctx)) {
    throw new ForbiddenError('Only administrators can create event types for other interviewers');
  }
}

/** Private resources (availability schedules, integrations, profile) are owner-only. */
export function assertOwner(ctx: AuthContext, resource: { organizationId: string; userId: string }, label = 'Resource') {
  if (resource.organizationId !== ctx.organization.id || resource.userId !== ctx.user.id) {
    throw new NotFoundError(`${label} not found`);
  }
}

export function canChangeRole(ctx: AuthContext, target: { userId: string }, newRole: MembershipRole) {
  if (!isAdmin(ctx)) return false;
  // Admins cannot demote themselves (prevents locking the organisation out by accident).
  if (target.userId === ctx.user.id && newRole !== 'admin') return false;
  return true;
}
