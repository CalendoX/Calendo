import type { Executor } from '../db/client';
import { db } from '../db/client';
import { auditLogs, type ActorType } from '../db/schema';
import type { RequestMeta } from '../http/request';

export type Actor =
  | { type: 'user'; userId: string; label?: string }
  | { type: 'candidate'; label: string }
  | { type: 'system'; label?: string }
  | { type: 'webhook'; label: string };

export type AuditAction =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'auth.password_reset_requested'
  | 'auth.password_reset'
  | 'auth.password_changed'
  | 'auth.email_verified'
  | 'organization.created'
  | 'organization.settings_updated'
  | 'organization.logo_updated'
  | 'organization.logo_removed'
  | 'organization.email_domain_added'
  | 'organization.email_domain_verified'
  | 'organization.email_domain_removed'
  | 'organization.email_sender_updated'
  | 'organization.holiday_added'
  | 'organization.holiday_removed'
  | 'notification_template.updated'
  | 'user.created'
  | 'user.approved'
  | 'user.signup_declined'
  | 'user.invited'
  | 'user.invitation_accepted'
  | 'user.activated'
  | 'user.deactivated'
  | 'user.role_changed'
  | 'user.profile_updated'
  | 'availability.created'
  | 'availability.updated'
  | 'availability.deleted'
  | 'event_type.created'
  | 'event_type.updated'
  | 'event_type.deleted'
  | 'scheduling_link.created'
  | 'scheduling_link.revoked'
  | 'interview.created'
  | 'interview.rescheduled'
  | 'interview.cancelled'
  | 'interview.status_changed'
  | 'interview.sync_retried'
  | 'integration.connected'
  | 'integration.disconnected'
  | 'integration.calendars_updated'
  | 'integration.failure'
  | 'integration.recovered'
  | 'integration.external_change';

export interface AuditEntry {
  organizationId: string | null;
  actor: Actor;
  action: AuditAction;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  meta?: RequestMeta | null;
}

export function actorColumns(actor: Actor): { actorType: ActorType; actorUserId: string | null; actorLabel: string | null } {
  switch (actor.type) {
    case 'user':
      return { actorType: 'user', actorUserId: actor.userId, actorLabel: actor.label ?? null };
    case 'candidate':
      return { actorType: 'candidate', actorUserId: null, actorLabel: actor.label };
    case 'webhook':
      return { actorType: 'webhook', actorUserId: null, actorLabel: actor.label };
    default:
      return { actorType: 'system', actorUserId: null, actorLabel: actor.label ?? 'System' };
  }
}

export async function recordAudit(entry: AuditEntry, executor: Executor = db) {
  await executor.insert(auditLogs).values({
    organizationId: entry.organizationId,
    ...actorColumns(entry.actor),
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId ?? null,
    metadata: entry.metadata ?? {},
    ipAddress: entry.meta?.ip ?? null,
    userAgent: entry.meta?.userAgent ?? null,
  });
}
