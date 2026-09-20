import { DateTime } from 'luxon';
import { Avatar } from '@/components/ui/avatar';

export interface ActivityItem {
  id: string;
  action: string;
  actorType: string;
  actorName: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  ipAddress?: string | null;
}

const VERBS: Record<string, string> = {
  'auth.login': 'signed in',
  'auth.login_failed': 'failed to sign in',
  'auth.logout': 'signed out',
  'auth.password_reset_requested': 'requested a password reset',
  'auth.password_reset': 'reset their password',
  'auth.password_changed': 'changed their password',
  'auth.email_verified': 'verified their email',
  'organization.created': 'created the organization',
  'organization.settings_updated': 'updated organization settings',
  'organization.logo_updated': 'uploaded a new logo',
  'organization.logo_removed': 'removed the logo',
  'organization.email_domain_added': 'added an email sending domain',
  'organization.email_domain_verified': 'verified the email sending domain',
  'organization.email_domain_removed': 'removed the email sending domain',
  'organization.email_sender_updated': 'changed the email sender',
  'organization.holiday_added': 'added a company holiday',
  'organization.holiday_removed': 'removed a company holiday',
  'notification_template.updated': 'updated an email template',
  'user.created': 'created a user',
  'user.approved': 'approved a sign-up',
  'user.signup_declined': 'declined a sign-up',
  'user.invited': 'invited a user',
  'user.invitation_accepted': 'accepted their invitation',
  'user.activated': 'reactivated a user',
  'user.deactivated': 'deactivated a user',
  'user.role_changed': 'changed a user’s role',
  'user.profile_updated': 'updated their profile',
  'availability.created': 'created an availability schedule',
  'availability.updated': 'updated availability',
  'availability.deleted': 'deleted an availability schedule',
  'event_type.created': 'created an event type',
  'event_type.updated': 'updated an event type',
  'event_type.deleted': 'deleted an event type',
  'scheduling_link.created': 'created a scheduling link',
  'scheduling_link.revoked': 'deactivated a scheduling link',
  'interview.created': 'booked an interview',
  'interview.rescheduled': 'rescheduled an interview',
  'interview.cancelled': 'cancelled an interview',
  'interview.status_changed': 'changed an interview’s status',
  'interview.sync_retried': 'retried integration sync',
  'integration.connected': 'connected an integration',
  'integration.disconnected': 'disconnected an integration',
  'integration.calendars_updated': 'changed calendar settings',
  'integration.failure': 'reported an integration failure',
  'integration.recovered': 'recovered an integration',
  'integration.external_change': 'detected a change outside Calendor',
};

export function describeActivity(a: ActivityItem): string {
  const m = a.metadata;
  const bits: string[] = [];
  if (typeof m.eventType === 'string') bits.push(m.eventType);
  if (typeof m.name === 'string') bits.push(m.name);
  if (typeof m.email === 'string') bits.push(m.email);
  if (typeof m.candidateEmail === 'string') bits.push(m.candidateEmail);
  if (typeof m.provider === 'string') bits.push(m.provider === 'google_calendar' ? 'Google Calendar' : m.provider === 'zoom' ? 'Zoom' : m.provider);
  if (typeof m.from === 'string' && typeof m.to === 'string') bits.push(`${m.from} → ${m.to}`);
  if (typeof m.error === 'string') bits.push(m.error.slice(0, 120));
  if (typeof m.reason === 'string' && m.reason) bits.push(`“${m.reason}”`);
  return bits.join(' · ');
}

export function ActivityList({ items, zone, compact }: { items: ActivityItem[]; zone: string; compact?: boolean }) {
  if (items.length === 0) return <p className="px-5 py-8 text-center text-sm text-zinc-500">No activity yet.</p>;
  return (
    <ul className="divide-y divide-zinc-100">
      {items.map((a) => {
        const detail = describeActivity(a);
        return (
          <li key={a.id} className="flex gap-3 px-5 py-3">
            <Avatar name={a.actorName} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-zinc-800">
                <span className="font-medium text-zinc-900">{a.actorName}</span> {VERBS[a.action] ?? a.action}
              </p>
              {detail && <p className="truncate text-xs text-zinc-500">{detail}</p>}
              <p className="text-xs text-zinc-400">
                {DateTime.fromISO(a.createdAt, { zone }).toFormat(compact ? 'LLL d, h:mm a' : 'LLL d, yyyy · h:mm:ss a')}
                {!compact && a.ipAddress && ` · ${a.ipAddress}`}
                {!compact && <span className="ml-2 font-mono text-[10px] text-zinc-300">{a.action}</span>}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
