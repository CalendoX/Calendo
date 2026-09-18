import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client';
import { eventTypes, memberships, organizations, schedulingLinks, users, videoMeetings, type EventFieldConfig, type CustomQuestion } from '../db/schema';
import { GoneError, NotFoundError } from '../http/errors';
import { defaultScheduleId, loadPolicy } from '../scheduling/availability-service';
import { bookingLinksFor, lookupBookingToken, type BookingTokenPurpose } from '../scheduling/booking-tokens';
import { loadInterviewForCandidate } from '../scheduling/booking-service';
import { hashToken } from '../security/crypto';
import { initials, locationLabel } from '@/lib/format';

/**
 * Read models for unauthenticated, candidate-facing pages. Only presentation data is returned —
 * no internal identifiers are needed by the client, and nothing sensitive (emails of hosts,
 * credentials, host meeting URLs) is exposed.
 */

export interface PublicHost {
  name: string;
  username: string;
  title: string | null;
  initials: string;
}

export interface PublicOrganization {
  name: string;
  logoUrl: string | null;
  brandColor: string;
  bookingPageNotice: string | null;
}

export interface PublicEventType {
  name: string;
  slug: string;
  description: string | null;
  durationMinutes: number;
  locationType: (typeof eventTypes.$inferSelect)['locationType'];
  locationLabel: string;
  color: string;
  timezone: string;
  fieldConfig: EventFieldConfig;
  questions: CustomQuestion[];
  maxDaysInFuture: number | null;
}

function orgDto(o: typeof organizations.$inferSelect): PublicOrganization {
  return { name: o.name, logoUrl: o.logoUrl, brandColor: o.brandColor, bookingPageNotice: o.settings.bookingPageNotice || null };
}

function hostDto(u: typeof users.$inferSelect): PublicHost {
  return { name: u.name, username: u.username, title: u.title, initials: initials(u.name) };
}

async function activeHost(username: string) {
  const [user] = await db.select().from(users).where(eq(users.username, username.toLowerCase())).limit(1);
  if (!user || user.status !== 'active' || !user.emailVerifiedAt) return null;
  return user;
}

export async function getPublicProfile(username: string) {
  const host = await activeHost(username);
  if (!host) return null;
  const rows = await db
    .select({ eventType: eventTypes, organization: organizations, membershipStatus: memberships.status })
    .from(eventTypes)
    .innerJoin(organizations, eq(organizations.id, eventTypes.organizationId))
    .innerJoin(memberships, and(eq(memberships.organizationId, eventTypes.organizationId), eq(memberships.userId, eventTypes.hostUserId)))
    .where(
      and(
        eq(eventTypes.hostUserId, host.id),
        eq(eventTypes.isActive, true),
        eq(eventTypes.visibility, 'public'),
        isNull(eventTypes.deletedAt),
        eq(memberships.status, 'active'),
      ),
    )
    .orderBy(asc(eventTypes.durationMinutes), asc(eventTypes.name));
  return {
    host: hostDto(host),
    organization: rows[0] ? orgDto(rows[0].organization) : null,
    eventTypes: rows.map((r) => ({
      name: r.eventType.name,
      slug: r.eventType.slug,
      description: r.eventType.description,
      durationMinutes: r.eventType.durationMinutes,
      locationLabel: locationLabel(r.eventType.locationType, r.eventType.locationDetails),
      locationType: r.eventType.locationType,
      color: r.eventType.color,
    })),
  };
}

export interface ResolvedPublicEvent {
  eventTypeId: string;
  host: PublicHost;
  organization: PublicOrganization;
  eventType: PublicEventType;
  link: { candidateName: string | null; candidateEmail: string | null } | null;
}

/** Resolves /schedule/:username/:slug (optionally via a personal scheduling link token). */
export async function resolvePublicEventType(username: string, slug: string, linkToken?: string | null): Promise<ResolvedPublicEvent> {
  const unavailable = new NotFoundError('This scheduling page is not available.');
  const host = await activeHost(username);
  if (!host) throw unavailable;
  const [row] = await db
    .select({ eventType: eventTypes, organization: organizations, membershipStatus: memberships.status })
    .from(eventTypes)
    .innerJoin(organizations, eq(organizations.id, eventTypes.organizationId))
    .innerJoin(memberships, and(eq(memberships.organizationId, eventTypes.organizationId), eq(memberships.userId, eventTypes.hostUserId)))
    .where(and(eq(eventTypes.hostUserId, host.id), eq(eventTypes.slug, slug.toLowerCase()), isNull(eventTypes.deletedAt)))
    .limit(1);
  if (!row || !row.eventType.isActive || row.membershipStatus !== 'active') throw unavailable;

  let link: ResolvedPublicEvent['link'] = null;
  if (linkToken) {
    const [l] = await db.select().from(schedulingLinks).where(eq(schedulingLinks.tokenHash, hashToken(linkToken))).limit(1);
    if (!l || l.eventTypeId !== row.eventType.id) throw new NotFoundError('This scheduling link is not valid.');
    if (l.revokedAt) throw new GoneError('This scheduling link has been deactivated. Please contact your recruiter for a new link.', 'LINK_REVOKED');
    if (l.expiresAt && l.expiresAt.getTime() <= Date.now()) throw new GoneError('This scheduling link has expired. Please contact your recruiter for a new link.', 'LINK_EXPIRED');
    if (l.maxUses !== null && l.useCount >= l.maxUses) throw new GoneError('This scheduling link has already been used to book an interview.', 'LINK_USED');
    link = { candidateName: l.candidateName, candidateEmail: l.candidateEmail };
  } else if (row.eventType.visibility === 'link_only') {
    throw unavailable;
  }

  const scheduleId = row.eventType.scheduleId ?? (await defaultScheduleId(host.id, row.organization.id));
  const { policy } = await loadPolicy(scheduleId, row.organization.id, host.timezone);
  const e = row.eventType;
  return {
    eventTypeId: e.id,
    host: hostDto(host),
    organization: orgDto(row.organization),
    eventType: {
      name: e.name,
      slug: e.slug,
      description: e.description,
      durationMinutes: e.durationMinutes,
      locationType: e.locationType,
      locationLabel: locationLabel(e.locationType, e.locationDetails),
      color: e.color,
      timezone: policy.timezone,
      fieldConfig: e.fieldConfig,
      questions: e.questions,
      maxDaysInFuture: e.maxDaysInFuture,
    },
    link,
  };
}

/** /s/:token → the event type it books. */
export async function resolveSchedulingLinkTarget(token: string) {
  const [row] = await db
    .select({ slug: eventTypes.slug, username: users.username })
    .from(schedulingLinks)
    .innerJoin(eventTypes, eq(eventTypes.id, schedulingLinks.eventTypeId))
    .innerJoin(users, eq(users.id, eventTypes.hostUserId))
    .where(eq(schedulingLinks.tokenHash, hashToken(token)))
    .limit(1);
  return row ?? null;
}

export interface CandidateBookingView {
  status: 'scheduled' | 'rescheduled' | 'cancelled' | 'completed' | 'no_show';
  startAt: string;
  endAt: string;
  candidateTimezone: string;
  host: PublicHost;
  organization: PublicOrganization;
  eventType: { name: string; durationMinutes: number; color: string; bookAgainUrl: string | null };
  location: { type: PublicEventType['locationType']; label: string; joinUrl: string | null; passcode: string | null; pending: boolean };
  candidate: { name: string; email: string };
  cancelReason: string | null;
  links: { view: string | null; reschedule: string | null; cancel: string | null };
  policy: { canReschedule: boolean; canCancel: boolean; reason: string | null };
}

export type CandidateLookup =
  | { ok: true; interviewId: string; view: CandidateBookingView }
  | { ok: false; reason: 'not_found' | 'expired' | 'revoked' };

export async function getCandidateBooking(token: string, purpose: BookingTokenPurpose): Promise<CandidateLookup> {
  const lookup = await lookupBookingToken(token, purpose);
  if (!lookup.ok) return lookup;
  const row = await loadInterviewForCandidate(lookup.interviewId);
  if (!row) return { ok: false, reason: 'not_found' };
  const [org] = await db.select().from(organizations).where(eq(organizations.id, row.interview.organizationId)).limit(1);
  const [meeting] = await db.select().from(videoMeetings).where(eq(videoMeetings.interviewId, row.interview.id)).limit(1);
  const links = await bookingLinksFor(row.interview.id);
  const active = row.interview.status === 'scheduled' || row.interview.status === 'rescheduled';
  const cutoffMs = (org.settings.candidateManageCutoffMinutes ?? 0) * 60_000;
  const tooLate = row.interview.startAt.getTime() - cutoffMs <= Date.now();
  let reason: string | null = null;
  if (!active) reason = row.interview.status === 'cancelled' ? 'This interview has been cancelled.' : 'This interview has already taken place.';
  else if (tooLate) reason = 'Changes are no longer possible online this close to the interview. Please contact your recruiter.';
  const joinUrl = active && meeting?.status === 'synced' ? meeting.joinUrl : null;
  return {
    ok: true,
    interviewId: row.interview.id,
    view: {
      status: row.interview.status,
      startAt: row.interview.startAt.toISOString(),
      endAt: row.interview.endAt.toISOString(),
      candidateTimezone: row.interview.candidateTimezone,
      host: hostDto(row.host),
      organization: orgDto(org),
      eventType: {
        name: row.eventType.name,
        durationMinutes: Math.round((row.interview.endAt.getTime() - row.interview.startAt.getTime()) / 60_000),
        color: row.eventType.color,
        bookAgainUrl:
          row.eventType.isActive && !row.eventType.deletedAt && row.eventType.visibility === 'public'
            ? `/schedule/${row.host.username}/${row.eventType.slug}`
            : null,
      },
      location: {
        type: row.interview.locationType,
        label: locationLabel(row.interview.locationType, row.interview.locationDetails),
        joinUrl,
        passcode: joinUrl ? (meeting?.passcode ?? null) : null,
        pending: row.interview.locationType === 'zoom' && active && !joinUrl,
      },
      candidate: { name: row.candidate.name, email: row.candidate.email },
      cancelReason: row.interview.cancelReason,
      links,
      policy: {
        canReschedule: active && !tooLate && org.settings.candidateCanReschedule !== false && Boolean(links.reschedule),
        canCancel: active && !tooLate && org.settings.candidateCanCancel !== false && Boolean(links.cancel),
        reason,
      },
    },
  };
}
