import { and, eq, sql } from 'drizzle-orm';
import { appUrl } from '../config/env';
import { db } from '../db/client';
import {
  calendarEvents,
  candidates,
  eventTypes,
  interviews,
  invitesCandidateAsCalendarGuest,
  notifications,
  notificationTemplates,
  organizations,
  users,
  videoMeetings,
} from '../db/schema';
import { bookingLinksFor } from '../scheduling/booking-tokens';
import { buildIcs, googleCalendarTemplateUrl, outlookCalendarUrl } from './ics';
import { getEmailProvider, SenderDomainRejectedError, type EmailMessage } from './email-provider';
import { markSendingDomainRejected, organizationSender } from '../services/email-domain-service';
import { renderEmail, type EmailContext } from './templates';
import { locationLabel } from '@/lib/format';

/**
 * Delivers a single notification row. Idempotent: already-sent or skipped notifications are
 * ignored, and notifications that no longer describe reality (e.g. a reminder for a time that
 * was rescheduled, or a confirmation for a cancelled interview) are marked `skipped`.
 */

export type DeliveryResult = 'sent' | 'skipped' | 'already_done' | 'missing';

const CONFIRMATION_TYPES = new Set(['booking_confirmation', 'reschedule_confirmation', 'meeting_details_update', 'reminder']);

async function markSkipped(id: string, reason: string) {
  await db
    .update(notifications)
    .set({ status: 'skipped', lastError: reason, updatedAt: new Date() })
    .where(eq(notifications.id, id));
}

export async function deliverNotification(notificationId: string, opts: { finalAttempt?: boolean } = {}): Promise<DeliveryResult> {
  const [n] = await db.select().from(notifications).where(eq(notifications.id, notificationId)).limit(1);
  if (!n) return 'missing';
  if (n.status === 'sent' || n.status === 'skipped') return 'already_done';
  if (!n.interviewId) {
    await markSkipped(n.id, 'No interview attached');
    return 'skipped';
  }

  const [row] = await db
    .select({ interview: interviews, eventType: eventTypes, host: users, candidate: candidates, organization: organizations })
    .from(interviews)
    .innerJoin(eventTypes, eq(eventTypes.id, interviews.eventTypeId))
    .innerJoin(users, eq(users.id, interviews.hostUserId))
    .innerJoin(candidates, eq(candidates.id, interviews.candidateId))
    .innerJoin(organizations, eq(organizations.id, interviews.organizationId))
    .where(eq(interviews.id, n.interviewId))
    .limit(1);
  if (!row) {
    await markSkipped(n.id, 'Interview no longer exists');
    return 'skipped';
  }
  const { interview, eventType, host, candidate, organization } = row;
  const active = interview.status === 'scheduled' || interview.status === 'rescheduled';

  // Relevance checks ------------------------------------------------------------------------
  if (n.type === 'reminder') {
    if (!active) return markSkipped(n.id, `Interview is ${interview.status}`).then(() => 'skipped');
    if (n.interviewVersion !== interview.version) return markSkipped(n.id, 'Interview time changed').then(() => 'skipped');
    if (interview.startAt.getTime() <= Date.now()) return markSkipped(n.id, 'Interview already started').then(() => 'skipped');
  }
  if ((n.type === 'booking_confirmation' || n.type === 'host_booking_notification' || n.type === 'meeting_details_update') && !active) {
    return markSkipped(n.id, `Interview is ${interview.status}`).then(() => 'skipped');
  }
  if ((n.type === 'reschedule_confirmation' || n.type === 'host_reschedule_notification') && (!active || n.interviewVersion !== interview.version)) {
    return markSkipped(n.id, 'Superseded by a later change').then(() => 'skipped');
  }

  const [override] = await db
    .select()
    .from(notificationTemplates)
    .where(and(eq(notificationTemplates.organizationId, organization.id), eq(notificationTemplates.type, n.type)))
    .limit(1);
  if (override && !override.enabled) return markSkipped(n.id, 'Disabled by organization').then(() => 'skipped');

  const [meeting] = await db.select().from(videoMeetings).where(eq(videoMeetings.interviewId, interview.id)).limit(1);
  const [calEvent] = await db.select().from(calendarEvents).where(eq(calendarEvents.interviewId, interview.id)).limit(1);
  const links = await bookingLinksFor(interview.id);
  const joinUrl = meeting && meeting.status === 'synced' ? meeting.joinUrl : null;
  if (n.type === 'meeting_details_update' && !joinUrl) return markSkipped(n.id, 'No meeting link available').then(() => 'skipped');

  const recipientKind = n.recipientType;
  const location = interview.locationType === 'zoom' ? joinUrl : locationLabel(interview.locationType, interview.locationDetails);
  const calendarDetails = [
    `${eventType.name} with ${host.name}`,
    joinUrl ? `Join: ${joinUrl}` : '',
    links.view ? `Details: ${links.view}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const bookAgain =
    eventType.isActive && !eventType.deletedAt && eventType.visibility === 'public'
      ? appUrl(`/schedule/${host.username}/${eventType.slug}`)
      : null;

  const ctx: EmailContext = {
    type: n.type,
    recipient: {
      name: n.recipientName ?? n.recipientEmail,
      email: n.recipientEmail,
      kind: recipientKind,
      timezone: recipientKind === 'candidate' ? interview.candidateTimezone : host.timezone,
    },
    // Uploaded logos are stored as app-relative paths; email clients need an absolute URL.
    organization: { name: organization.name, brandColor: organization.brandColor, logoUrl: organization.logoUrl && new URL(organization.logoUrl, appUrl()).toString() },
    eventType: { name: eventType.name, durationMinutes: Math.round((interview.endAt.getTime() - interview.startAt.getTime()) / 60_000) },
    host: { name: host.name, email: host.email, title: host.title },
    candidate,
    interview: {
      id: interview.id,
      start: interview.startAt,
      end: interview.endAt,
      locationType: interview.locationType,
      locationDetails: interview.locationDetails,
      responses: interview.responses,
      cancelReason: interview.cancelReason,
    },
    meeting: meeting ? { joinUrl, passcode: joinUrl ? meeting.passcode : null, pending: !joinUrl } : null,
    links: {
      ...links,
      dashboard: appUrl(`/interviews/${interview.id}`),
      googleCalendar: googleCalendarTemplateUrl({
        title: `${eventType.name} with ${host.name}`,
        start: interview.startAt,
        end: interview.endAt,
        details: calendarDetails,
        location,
      }),
      outlookCalendar: outlookCalendarUrl({
        title: `${eventType.name} with ${host.name}`,
        start: interview.startAt,
        end: interview.endAt,
        details: calendarDetails,
        location,
      }),
      bookAgain,
    },
    metadata: n.metadata,
    override: override ? { subject: override.subject, intro: override.intro } : null,
  };
  const rendered = renderEmail(ctx);

  // Calendar invitation: hosts only when Calendor is not writing to their calendar; candidates
  // unless Google already invited them as guests on that event (one calendar entry, not two).
  const googleInvitedCandidate = invitesCandidateAsCalendarGuest(organization.settings) && Boolean(calEvent?.externalEventId);
  const attachInvite =
    recipientKind === 'candidate'
      ? n.type !== 'reminder' && n.type !== 'host_booking_notification' && !googleInvitedCandidate
      : !calEvent && n.type !== 'reminder';
  const isCancel = n.type === 'cancellation' || n.type === 'host_cancellation_notification';
  // The business's own verified domain when it has one; otherwise the platform sender, named for the business.
  const orgSender = await organizationSender(organization.id);
  const platformFromName = `${organization.name} (via Calendor)`;
  const message: EmailMessage = {
    to: { email: n.recipientEmail, name: n.recipientName },
    from: orgSender ?? undefined,
    fromName: orgSender?.name ?? platformFromName,
    replyTo: recipientKind === 'candidate' ? host.email : candidate.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    headers: { 'X-Calendor-Notification': n.id, 'X-Entity-Ref-ID': n.id },
    icalEvent: attachInvite
      ? {
          method: isCancel ? 'CANCEL' : 'REQUEST',
          content: buildIcs({
            uid: `interview-${interview.id}@slate`,
            sequence: interview.version,
            method: isCancel ? 'CANCEL' : 'REQUEST',
            start: interview.startAt,
            end: interview.endAt,
            summary: recipientKind === 'candidate' ? `${eventType.name} with ${host.name}` : `${eventType.name}: ${candidate.name}`,
            description: calendarDetails,
            location,
            url: recipientKind === 'candidate' ? links.view : appUrl(`/interviews/${interview.id}`),
            organizer: { name: host.name, email: host.email },
            attendee: { name: candidate.name, email: candidate.email },
            status: isCancel ? 'CANCELLED' : 'CONFIRMED',
            rsvp: recipientKind === 'candidate',
          }),
        }
      : undefined,
  };

  const send = async () => {
    try {
      return await getEmailProvider().send(message);
    } catch (err) {
      if (!(orgSender && err instanceof SenderDomainRejectedError)) throw err;
      // The domain stopped verifying: flag it for the admin and deliver from the platform sender.
      console.warn(`[notifications] ${err.message}; sending from the platform sender instead`);
      await markSendingDomainRejected(organization.id);
      return getEmailProvider().send({ ...message, from: undefined, fromName: platformFromName });
    }
  };

  try {
    const result = await send();
    await db
      .update(notifications)
      .set({
        status: 'sent',
        sentAt: new Date(),
        providerMessageId: result.messageId,
        attempts: sql`${notifications.attempts} + 1`,
        lastError: null,
        metadata: CONFIRMATION_TYPES.has(n.type) ? { ...n.metadata, meetingJoinUrl: joinUrl } : n.metadata,
        updatedAt: new Date(),
      })
      .where(eq(notifications.id, n.id));
    return 'sent';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(notifications)
      .set({
        status: opts.finalAttempt ? 'failed' : 'queued',
        attempts: sql`${notifications.attempts} + 1`,
        lastError: message.slice(0, 1000),
        updatedAt: new Date(),
      })
      .where(eq(notifications.id, n.id));
    throw err;
  }
}
