import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { appUrl } from '../config/env';
import { db } from '../db/client';
import {
  calendarEvents,
  candidates,
  eventTypes,
  integrations,
  interviews,
  invitesCandidateAsCalendarGuest,
  organizations,
  users,
  videoMeetings,
} from '../db/schema';
import { dispatchSyncGatedNotifications, planMeetingDetailsUpdate } from '../notifications/planner';
import { bookingLinksFor } from '../scheduling/booking-tokens';
import { encrypt } from '../security/crypto';
import { recordAudit } from '../services/audit';
import { locationLabel } from '@/lib/format';
import {
  cancelCalendarEvent,
  cancelMeeting,
  createCalendarEvent,
  createMeeting,
  updateCalendarEvent,
  updateMeeting,
  type IntegrationRow,
} from './service';
import { IntegrationError, isIntegrationError, type CalendarEventInput, type MeetingInput } from './types';

/**
 * Integration reconciler.
 *
 * Given an interview, bring its Zoom meeting and interviewer-calendar event in line with the
 * interview's current state (created / moved / cancelled). The operation is idempotent and
 * versioned: each external record stores the interview `version` it reflects, so replays and
 * retries do nothing once everything is in sync.
 *
 * Runs from the `interview-sync` job (with retries + backoff) and inline right after a booking
 * change for fast feedback. A short database lease ensures only one run per interview at a time.
 *
 * Failures are recorded on the record (status `failed`, `last_error`) and surfaced in the UI with
 * a retry action. Retryable failures (network, 5xx, 429) are retried by the job queue; permanent
 * ones (revoked access, not connected) wait for the user to reconnect or retry.
 */

const LEASE_MS = 90_000;

export class SyncRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncRetryableError';
  }
}

export interface SyncOutcome {
  interviewId: string;
  skipped?: 'lease_busy' | 'not_found';
  meeting: 'ok' | 'failed' | 'skipped';
  calendar: 'ok' | 'failed' | 'skipped';
  retryable: boolean;
  errors: string[];
}

async function acquireLease(interviewId: string, owner: string) {
  const until = new Date(Date.now() + LEASE_MS);
  const rows = await db
    .update(interviews)
    .set({ syncLeaseUntil: until, syncLeaseOwner: owner })
    .where(and(eq(interviews.id, interviewId), or(isNull(interviews.syncLeaseUntil), lt(interviews.syncLeaseUntil, new Date()))))
    .returning({ id: interviews.id });
  return rows.length > 0;
}

async function releaseLease(interviewId: string, owner: string) {
  await db
    .update(interviews)
    .set({ syncLeaseUntil: null, syncLeaseOwner: null })
    .where(and(eq(interviews.id, interviewId), eq(interviews.syncLeaseOwner, owner)));
}

function errorMessage(err: unknown) {
  if (isIntegrationError(err)) {
    if (err.kind === 'auth') return `Reconnect required: ${err.message}`;
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function isRetryable(err: unknown) {
  return isIntegrationError(err) ? err.retryable : true; // unknown errors: assume transient
}

type Loaded = NonNullable<Awaited<ReturnType<typeof loadForSync>>>;

async function loadForSync(interviewId: string) {
  const [row] = await db
    .select({ interview: interviews, eventType: eventTypes, host: users, candidate: candidates, organization: organizations })
    .from(interviews)
    .innerJoin(eventTypes, eq(eventTypes.id, interviews.eventTypeId))
    .innerJoin(users, eq(users.id, interviews.hostUserId))
    .innerJoin(candidates, eq(candidates.id, interviews.candidateId))
    .innerJoin(organizations, eq(organizations.id, interviews.organizationId))
    .where(eq(interviews.id, interviewId))
    .limit(1);
  if (!row) return null;
  const [meeting] = await db.select().from(videoMeetings).where(eq(videoMeetings.interviewId, interviewId)).limit(1);
  const [calendarEvent] = await db.select().from(calendarEvents).where(eq(calendarEvents.interviewId, interviewId)).limit(1);
  return { ...row, meeting: meeting ?? null, calendarEvent: calendarEvent ?? null };
}

async function integrationById(id: string | null): Promise<IntegrationRow | null> {
  if (!id) return null;
  const [row] = await db.select().from(integrations).where(eq(integrations.id, id)).limit(1);
  return row ?? null;
}

async function activeIntegrationFor(userId: string, provider: IntegrationRow['provider']) {
  const [row] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.userId, userId), eq(integrations.provider, provider)))
    .limit(1);
  return row ?? null;
}

function requireActive(integration: IntegrationRow | null, provider: IntegrationRow['provider']): IntegrationRow {
  const label = provider === 'zoom' ? 'Zoom' : 'Google Calendar';
  if (!integration) throw new IntegrationError(provider, 'not_connected', `${label} is not connected for this interviewer.`);
  if (integration.status !== 'active') {
    throw new IntegrationError(provider, 'auth', `${label} needs to be reconnected (${integration.lastError ?? 'authorization error'}).`);
  }
  return integration;
}

function formatWhen(d: Loaded) {
  const start = DateTime.fromJSDate(d.interview.startAt, { zone: d.interview.timezone });
  const end = DateTime.fromJSDate(d.interview.endAt, { zone: d.interview.timezone });
  return `${start.toFormat('cccc, LLLL d, yyyy')} · ${start.toFormat('h:mm a')} – ${end.toFormat('h:mm a ZZZZ')} (${d.interview.timezone})`;
}

function meetingInput(d: Loaded): MeetingInput {
  return {
    interviewId: d.interview.id,
    topic: `${d.eventType.name} — ${d.candidate.name}`,
    agenda: `${d.eventType.name} with ${d.candidate.name} (${d.candidate.email}). Interviewer: ${d.host.name}.`,
    start: d.interview.startAt,
    durationMinutes: Math.round((d.interview.endAt.getTime() - d.interview.startAt.getTime()) / 60_000),
    timezone: d.interview.timezone,
    invitees: [{ email: d.candidate.email, name: d.candidate.name }],
  };
}

/**
 * The interviewer's calendar event. When the candidate is a guest they see the description too, so
 * it then links to the candidate's own booking page (no sign-in) instead of the Calendor dashboard;
 * the dashboard link stays in `sourceUrl`, which Google only shows to the event's creator.
 */
function calendarInput(d: Loaded, joinUrl: string | null, candidateBookingUrl: string | null): CalendarEventInput {
  const candidateIsGuest = invitesCandidateAsCalendarGuest(d.organization.settings);
  const lines = [
    candidateIsGuest ? `${d.eventType.name} with ${d.host.name} and ${d.candidate.name}` : `${d.eventType.name} with ${d.candidate.name}`,
    '',
    `When: ${formatWhen(d)}`,
    `Interviewer: ${d.host.name} <${d.host.email}>`,
    `Candidate: ${d.candidate.name} <${d.candidate.email}>`,
  ];
  if (d.candidate.phone) lines.push(`Phone: ${d.candidate.phone}`);
  if (d.candidate.linkedinUrl) lines.push(`LinkedIn: ${d.candidate.linkedinUrl}`);
  if (d.candidate.resumeUrl) lines.push(`Résumé: ${d.candidate.resumeUrl}`);
  if (d.candidate.company) lines.push(`Company: ${d.candidate.company}`);
  lines.push('');
  if (joinUrl) lines.push(`Join Zoom meeting: ${joinUrl}`, '');
  else if (d.interview.locationType === 'zoom') lines.push('Zoom link: pending — it will be added automatically.', '');
  else lines.push(`Location: ${locationLabel(d.interview.locationType, d.interview.locationDetails)}`, '');
  if (d.interview.responses.length) {
    lines.push('Candidate responses:');
    for (const r of d.interview.responses) lines.push(`• ${r.label}: ${r.answer}`);
    lines.push('');
  }
  if (!candidateIsGuest) lines.push(`Interview details: ${appUrl(`/interviews/${d.interview.id}`)}`);
  else if (candidateBookingUrl) lines.push(`View, reschedule or cancel this booking: ${candidateBookingUrl}`);

  const location = joinUrl ?? (d.interview.locationType === 'zoom' ? null : d.interview.locationDetails);
  return {
    interviewId: d.interview.id,
    title: `${d.eventType.name}: ${d.candidate.name}`,
    description: lines.join('\n'),
    location,
    start: d.interview.startAt,
    end: d.interview.endAt,
    timezone: d.interview.timezone,
    attendees: candidateIsGuest ? [{ email: d.candidate.email, name: d.candidate.name }] : [],
    notifyAttendees: candidateIsGuest,
    sourceUrl: appUrl(`/interviews/${d.interview.id}`),
  };
}

async function recordFailure(
  table: typeof videoMeetings | typeof calendarEvents,
  rowId: string,
  d: Loaded,
  provider: string,
  err: unknown,
  previousStatus: string,
) {
  const message = errorMessage(err).slice(0, 1000);
  await db
    .update(table)
    .set({
      status: 'failed',
      lastError: message,
      lastAttemptAt: new Date(),
      attempts: sql`${table.attempts} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(table.id, rowId));
  if (previousStatus !== 'failed') {
    await recordAudit({
      organizationId: d.interview.organizationId,
      actor: { type: 'system', label: 'Integration sync' },
      action: 'integration.failure',
      resourceType: 'interview',
      resourceId: d.interview.id,
      metadata: { provider, error: message, retryable: isRetryable(err) },
    });
  }
}

async function syncMeeting(d: Loaded, opts: { force: boolean }): Promise<{ status: 'ok' | 'failed' | 'skipped'; joinUrlChanged: boolean; joinUrl: string | null; error?: unknown }> {
  const m = d.meeting;
  if (!m) return { status: 'skipped', joinUrlChanged: false, joinUrl: null };
  const active = d.interview.status === 'scheduled' || d.interview.status === 'rescheduled';
  const cancelled = d.interview.status === 'cancelled';
  const version = d.interview.version;

  try {
    if (active) {
      if (m.status === 'deleted_externally' && !opts.force) return { status: 'skipped', joinUrlChanged: false, joinUrl: m.joinUrl };
      const needsWork = m.syncedVersion < version || m.status !== 'synced' || !m.externalMeetingId;
      if (!needsWork) return { status: 'ok', joinUrlChanged: false, joinUrl: m.joinUrl };
      // Prefer the integration recorded on the meeting; fall back to the host's current one (reconnects).
      const integration = requireActive(
        (await integrationById(m.integrationId)) ?? (await activeIntegrationFor(d.interview.hostUserId, m.provider)),
        m.provider,
      );
      const input = meetingInput(d);
      let joinUrl = m.joinUrl;
      let externalMeetingId = m.externalMeetingId;
      let hostUrlEncrypted = m.hostUrlEncrypted;
      let passcode = m.passcode;
      const recreate = !externalMeetingId || m.status === 'deleted_externally' || m.integrationId !== integration.id;
      if (!recreate) {
        try {
          const res = await updateMeeting(integration, externalMeetingId!, input);
          if (res.joinUrl) joinUrl = res.joinUrl;
        } catch (err) {
          if (!(isIntegrationError(err) && err.kind === 'not_found')) throw err;
          externalMeetingId = null; // deleted on the provider side: create a fresh one
        }
      }
      if (recreate || !externalMeetingId) {
        const res = await createMeeting(integration, input);
        externalMeetingId = res.externalMeetingId;
        joinUrl = res.joinUrl;
        hostUrlEncrypted = res.hostUrl ? encrypt(res.hostUrl) : null;
        passcode = res.passcode;
      }
      await db
        .update(videoMeetings)
        .set({
          integrationId: integration.id,
          externalMeetingId,
          joinUrl,
          passcode,
          hostUrlEncrypted,
          status: 'synced',
          syncedVersion: version,
          lastError: null,
          lastAttemptAt: new Date(),
          syncedAt: new Date(),
          attempts: sql`${videoMeetings.attempts} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(videoMeetings.id, m.id));
      if (m.status === 'failed') {
        await recordAudit({
          organizationId: d.interview.organizationId,
          actor: { type: 'system', label: 'Integration sync' },
          action: 'integration.recovered',
          resourceType: 'interview',
          resourceId: d.interview.id,
          metadata: { provider: m.provider },
        });
      }
      return { status: 'ok', joinUrlChanged: joinUrl !== m.joinUrl, joinUrl };
    }

    if (cancelled) {
      if (m.status === 'cancelled') return { status: 'ok', joinUrlChanged: false, joinUrl: null };
      if (m.externalMeetingId && m.status !== 'deleted_externally') {
        const integration = requireActive(
          (await integrationById(m.integrationId)) ?? (await activeIntegrationFor(d.interview.hostUserId, m.provider)),
          m.provider,
        );
        await cancelMeeting(integration, m.externalMeetingId);
      }
      await db
        .update(videoMeetings)
        .set({ status: 'cancelled', syncedVersion: version, lastError: null, lastAttemptAt: new Date(), updatedAt: new Date() })
        .where(eq(videoMeetings.id, m.id));
      return { status: 'ok', joinUrlChanged: false, joinUrl: null };
    }
    return { status: 'skipped', joinUrlChanged: false, joinUrl: m.joinUrl };
  } catch (err) {
    await recordFailure(videoMeetings, m.id, d, m.provider, err, m.status);
    return { status: 'failed', joinUrlChanged: false, joinUrl: m.joinUrl, error: err };
  }
}

async function syncCalendar(
  d: Loaded,
  meeting: { joinUrl: string | null; joinUrlChanged: boolean },
  opts: { force: boolean },
): Promise<{ status: 'ok' | 'failed' | 'skipped'; error?: unknown }> {
  const ev = d.calendarEvent;
  if (!ev) return { status: 'skipped' };
  const active = d.interview.status === 'scheduled' || d.interview.status === 'rescheduled';
  const cancelled = d.interview.status === 'cancelled';
  const version = d.interview.version;

  try {
    if (active) {
      if (ev.status === 'deleted_externally' && !opts.force) return { status: 'skipped' };
      const needsWork = ev.syncedVersion < version || ev.status !== 'synced' || !ev.externalEventId || meeting.joinUrlChanged;
      if (!needsWork) return { status: 'ok' };
      const integration = requireActive(
        (await integrationById(ev.integrationId)) ?? (await activeIntegrationFor(d.interview.hostUserId, ev.provider)),
        ev.provider,
      );
      if (!ev.externalCalendarId) throw new IntegrationError(ev.provider, 'permanent', 'No calendar selected for new interviews.');
      const input = calendarInput(d, meeting.joinUrl, (await bookingLinksFor(d.interview.id)).view);
      let result;
      if (ev.externalEventId && ev.status !== 'deleted_externally' && ev.integrationId === integration.id) {
        try {
          result = await updateCalendarEvent(integration, ev.externalCalendarId, ev.externalEventId, input);
        } catch (err) {
          if (!(isIntegrationError(err) && err.kind === 'not_found')) throw err;
          result = await createCalendarEvent(integration, ev.externalCalendarId, input);
        }
      } else {
        result = await createCalendarEvent(integration, ev.externalCalendarId, input);
      }
      await db
        .update(calendarEvents)
        .set({
          integrationId: integration.id,
          externalEventId: result.externalEventId,
          htmlLink: result.htmlLink,
          status: 'synced',
          syncedVersion: version,
          lastError: null,
          lastAttemptAt: new Date(),
          syncedAt: new Date(),
          attempts: sql`${calendarEvents.attempts} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(calendarEvents.id, ev.id));
      if (ev.status === 'failed') {
        await recordAudit({
          organizationId: d.interview.organizationId,
          actor: { type: 'system', label: 'Integration sync' },
          action: 'integration.recovered',
          resourceType: 'interview',
          resourceId: d.interview.id,
          metadata: { provider: ev.provider },
        });
      }
      return { status: 'ok' };
    }

    if (cancelled) {
      if (ev.status === 'cancelled') return { status: 'ok' };
      if (ev.externalEventId && ev.externalCalendarId && ev.status !== 'deleted_externally') {
        const integration = requireActive(
          (await integrationById(ev.integrationId)) ?? (await activeIntegrationFor(d.interview.hostUserId, ev.provider)),
          ev.provider,
        );
        await cancelCalendarEvent(integration, ev.externalCalendarId, ev.externalEventId, invitesCandidateAsCalendarGuest(d.organization.settings));
      }
      await db
        .update(calendarEvents)
        .set({ status: 'cancelled', syncedVersion: version, lastError: null, lastAttemptAt: new Date(), updatedAt: new Date() })
        .where(eq(calendarEvents.id, ev.id));
      return { status: 'ok' };
    }
    return { status: 'skipped' };
  } catch (err) {
    await recordFailure(calendarEvents, ev.id, d, ev.provider, err, ev.status);
    return { status: 'failed', error: err };
  }
}

/**
 * Reconciles one interview. Returns an outcome; callers decide whether to retry
 * (`outcome.retryable`). `force` re-creates records that were deleted directly in the provider.
 */
export async function syncInterviewIntegrations(
  interviewId: string,
  opts: { force?: boolean; waitForLeaseMs?: number } = {},
): Promise<SyncOutcome> {
  const owner = randomUUID();
  const deadline = Date.now() + (opts.waitForLeaseMs ?? 0);
  let leased = await acquireLease(interviewId, owner);
  while (!leased && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    leased = await acquireLease(interviewId, owner);
  }
  if (!leased) {
    return { interviewId, skipped: 'lease_busy', meeting: 'skipped', calendar: 'skipped', retryable: true, errors: [] };
  }
  try {
    const d = await loadForSync(interviewId);
    if (!d) return { interviewId, skipped: 'not_found', meeting: 'skipped', calendar: 'skipped', retryable: false, errors: [] };

    const meeting = await syncMeeting(d, { force: Boolean(opts.force) });
    const calendar = await syncCalendar(d, meeting, { force: Boolean(opts.force) });

    // Confirmations waited for this first attempt so they can include the meeting link.
    await db.transaction(async (tx) => {
      await dispatchSyncGatedNotifications(tx, interviewId);
      if (meeting.joinUrlChanged && meeting.joinUrl) {
        await planMeetingDetailsUpdate(tx, d.interview, d.candidate, meeting.joinUrl);
      }
    });

    const errors = [meeting.error, calendar.error].filter(Boolean).map(errorMessage);
    const retryable = [meeting.error, calendar.error].some((e) => e && isRetryable(e));
    return { interviewId, meeting: meeting.status, calendar: calendar.status, retryable, errors };
  } finally {
    await releaseLease(interviewId, owner);
  }
}

/**
 * Best-effort synchronous sync right after a booking change (bounded by `timeoutMs`), so the
 * candidate's confirmation page can show the Zoom link. The queued job remains the source of
 * reliability: if this times out or fails, the worker retries with backoff.
 */
export async function runInlineSync(interviewId: string, timeoutMs = 12_000) {
  const work = syncInterviewIntegrations(interviewId).catch((err) => {
    console.warn(`[sync] inline sync for ${interviewId} failed:`, err instanceof Error ? err.message : err);
    return null;
  });
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs).unref?.());
  return Promise.race([work, timeout]);
}
