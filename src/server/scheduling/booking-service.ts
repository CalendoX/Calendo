import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { db, PG_ERRORS, pgConstraintName, pgErrorCode, type Executor, type Transaction } from '../db/client';
import {
  calendarEvents,
  candidates,
  eventTypes,
  interviewReschedules,
  interviews,
  schedulingLinks,
  users,
  videoMeetings,
  type QuestionResponse,
} from '../db/schema';
import { BadRequestError, ConflictError, ForbiddenError, GoneError, NotFoundError, ValidationError } from '../http/errors';
import type { RequestMeta } from '../http/request';
import { getActiveIntegration, getAvailability, getWriteCalendar } from '../integrations/service';
import { LOCATION_CONFERENCING_PROVIDER } from '../integrations/registry';
import { enqueueInterviewSync } from '../jobs/queue';
import { planBooked, planCancelled, planRescheduled } from '../notifications/planner';
import { hashToken } from '../security/crypto';
import { recordAudit, type Actor } from '../services/audit';
import {
  ACTIVE_INTERVIEW_STATUSES,
  loadActiveInterviews,
  loadSchedulingContext,
  subtractRange,
  type SchedulingContext,
} from './availability-service';
import { bookingLinksFor, issueBookingTokens, revokeBookingTokens, updateTokenExpiries } from './booking-tokens';
import { checkSlot, loadWindowFor, SLOT_REJECTION_MESSAGES, type CheckSlotOptions, type EventConstraints } from './engine';
import { runInlineSync } from '../integrations/sync';

/**
 * Booking, rescheduling and cancellation.
 *
 * Correctness under concurrency:
 *   1. Free/busy from external calendars is fetched live (never cached) just before the write.
 *   2. Inside one transaction we take a per-interviewer advisory lock, re-load the host's
 *      interviews, and re-run the engine's checkSlot() — the same code that produced the slots.
 *   3. A Postgres exclusion constraint (interviews_no_overlapping_active) rejects any
 *      overlapping active interview for the same interviewer as a final safety net.
 *   4. Idempotency keys make client retries return the original booking.
 *
 * Integration work (Zoom, Google Calendar) and emails are recorded/enqueued in the same
 * transaction and executed afterwards, so a provider outage never loses a booking and a
 * rolled-back booking never produces side effects.
 */

export type InterviewRow = typeof interviews.$inferSelect;

export interface CandidateInput {
  name: string;
  email: string;
  phone?: string | null;
  company?: string | null;
  linkedinUrl?: string | null;
  resumeUrl?: string | null;
  timezone: string;
}

export interface BookInput {
  eventTypeId: string;
  start: Date;
  candidate: CandidateInput;
  answers: Record<string, string>;
  source: 'public_page' | 'scheduling_link' | 'dashboard';
  schedulingLinkToken?: string | null;
  idempotencyKey?: string | null;
  actor: Actor;
  meta?: RequestMeta | null;
  /** Dashboard bookings by hosts/admins may bypass working hours / notice (never conflicts). */
  hostOverrides?: CheckSlotOptions;
  /** Wait (bounded) for Zoom/Calendar creation so the response can include the meeting link. */
  inlineSync?: boolean;
}

export interface BookResult {
  interviewId: string;
  created: boolean;
  viewToken: string | null;
}

async function lockHost(tx: Transaction, hostUserId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`host:${hostUserId}`}, 0))`);
}

function slotConflict(reason: string, message?: string) {
  return new ConflictError(message ?? 'That time is no longer available. Please choose another time.', 'SLOT_UNAVAILABLE', { reason });
}

function isOverlapViolation(err: unknown) {
  return pgErrorCode(err) === PG_ERRORS.EXCLUSION_VIOLATION && pgConstraintName(err) === 'interviews_no_overlapping_active';
}

/** Validates candidate details + custom question answers against the event type's form config. */
export function validateBookingForm(ctx: SchedulingContext, candidate: CandidateInput, answers: Record<string, string>) {
  const errors: Record<string, string[]> = {};
  const fc = ctx.eventType.fieldConfig;
  const fields = { phone: candidate.phone, company: candidate.company, linkedinUrl: candidate.linkedinUrl, resumeUrl: candidate.resumeUrl };
  const cleaned: Partial<Record<keyof typeof fields, string | null>> = {};
  for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
    const mode = fc[key];
    const value = fields[key]?.trim() || null;
    if (mode === 'hidden') {
      cleaned[key] = null;
      continue;
    }
    if (mode === 'required' && !value) (errors[key] ??= []).push('Required');
    cleaned[key] = value;
  }
  if (cleaned.linkedinUrl && !/^https?:\/\/([a-z0-9-]+\.)?linkedin\.com\//i.test(cleaned.linkedinUrl)) {
    (errors.linkedinUrl ??= []).push('Enter a LinkedIn profile URL');
  }
  if (cleaned.resumeUrl && !/^https?:\/\//i.test(cleaned.resumeUrl)) (errors.resumeUrl ??= []).push('Enter a valid URL');
  if (cleaned.phone && !/^[+()\d\s.-]{6,25}$/.test(cleaned.phone)) (errors.phone ??= []).push('Enter a valid phone number');

  const responses: QuestionResponse[] = [];
  for (const q of ctx.eventType.questions) {
    const answer = (answers[q.id] ?? '').trim();
    if (!answer) {
      if (q.required) (errors[`answers.${q.id}`] ??= []).push('Required');
      continue;
    }
    if (answer.length > 5000) (errors[`answers.${q.id}`] ??= []).push('Answer is too long');
    if (q.type === 'single_select' && q.options && !q.options.includes(answer)) {
      (errors[`answers.${q.id}`] ??= []).push('Choose one of the options');
    }
    if (q.type === 'url' && !/^https?:\/\//i.test(answer)) (errors[`answers.${q.id}`] ??= []).push('Enter a valid URL');
    responses.push({ questionId: q.id, label: q.label, answer });
  }
  if (Object.keys(errors).length) throw new ValidationError('Please correct the highlighted fields.', errors);
  return { cleaned, responses };
}

export function assertBookable(ctx: SchedulingContext) {
  if (!ctx.eventType.isActive || ctx.eventType.deletedAt) throw new NotFoundError('This scheduling page is not available.');
  if (ctx.host.status !== 'active' || !ctx.hostMembershipActive || !ctx.host.emailVerifiedAt) {
    throw new NotFoundError('This scheduling page is not available.');
  }
}

async function existingByIdempotencyKey(eventTypeId: string, key: string, executor: Executor = db) {
  const [row] = await executor
    .select({ id: interviews.id })
    .from(interviews)
    .where(and(eq(interviews.eventTypeId, eventTypeId), eq(interviews.idempotencyKey, key)))
    .limit(1);
  return row ?? null;
}

async function viewTokenFor(interviewId: string): Promise<string | null> {
  const links = await bookingLinksFor(interviewId);
  return links.view ? links.view.split('/booking/')[1] : null;
}

export async function bookInterview(input: BookInput): Promise<BookResult> {
  const ctx = await loadSchedulingContext(input.eventTypeId);
  assertBookable(ctx);
  const { cleaned, responses } = validateBookingForm(ctx, input.candidate, input.answers);

  if (input.idempotencyKey) {
    const existing = await existingByIdempotencyKey(ctx.eventType.id, input.idempotencyKey);
    if (existing) return { interviewId: existing.id, created: false, viewToken: await viewTokenFor(existing.id) };
  }

  const start = input.start;
  if (Number.isNaN(start.getTime())) throw new BadRequestError('Invalid start time');
  const window = loadWindowFor(ctx.policy.timezone, start.getTime());
  // Live free/busy — throws CalendarUnavailableError (503) rather than assuming "free".
  const calendar = await getAvailability(ctx.host.id, window);

  const [zoomIntegration, googleIntegration] = await Promise.all([
    getActiveIntegration(ctx.host.id, 'zoom'),
    getActiveIntegration(ctx.host.id, 'google_calendar'),
  ]);
  const writeCalendar = googleIntegration ? await getWriteCalendar(googleIntegration.id) : null;

  let outcome: { interview: InterviewRow; viewToken: string | null };
  try {
    outcome = await db.transaction(async (tx) => {
      await lockHost(tx, ctx.host.id);

      if (input.idempotencyKey) {
        const existing = await existingByIdempotencyKey(ctx.eventType.id, input.idempotencyKey, tx);
        if (existing) {
          const [row] = await tx.select().from(interviews).where(eq(interviews.id, existing.id));
          return { interview: row, viewToken: null };
        }
      }

      // Scheduling links: validated and consumed atomically.
      let linkId: string | null = null;
      if (input.schedulingLinkToken) {
        const [link] = await tx
          .select()
          .from(schedulingLinks)
          .where(eq(schedulingLinks.tokenHash, hashToken(input.schedulingLinkToken)))
          .for('update');
        if (!link || link.eventTypeId !== ctx.eventType.id) throw new NotFoundError('This scheduling link is not valid.');
        if (link.revokedAt) throw new GoneError('This scheduling link has been deactivated.', 'LINK_REVOKED');
        if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) throw new GoneError('This scheduling link has expired.', 'LINK_EXPIRED');
        if (link.maxUses !== null && link.useCount >= link.maxUses) throw new GoneError('This scheduling link has already been used.', 'LINK_USED');
        await tx.update(schedulingLinks).set({ useCount: link.useCount + 1 }).where(eq(schedulingLinks.id, link.id));
        linkId = link.id;
      } else if (ctx.eventType.visibility === 'link_only' && input.source !== 'dashboard') {
        throw new NotFoundError('This scheduling page is not available.');
      }

      const email = input.candidate.email.trim().toLowerCase();
      const [dup] = await tx
        .select({ id: interviews.id, startAt: interviews.startAt })
        .from(interviews)
        .innerJoin(candidates, eq(candidates.id, interviews.candidateId))
        .where(
          and(
            eq(interviews.eventTypeId, ctx.eventType.id),
            eq(candidates.organizationId, ctx.organization.id),
            eq(candidates.email, email),
            inArray(interviews.status, [...ACTIVE_INTERVIEW_STATUSES]),
            gt(interviews.endAt, new Date()),
          ),
        )
        .limit(1);
      if (dup) {
        throw new ConflictError(
          'You already have this interview scheduled. Use the reschedule link in your confirmation email to change the time.',
          'DUPLICATE_BOOKING',
          { existingStart: dup.startAt.toISOString() },
        );
      }

      const existing = await loadActiveInterviews(ctx.host.id, window, tx);
      const verdict = checkSlot(
        ctx.policy,
        ctx.constraints,
        { now: Date.now(), calendarBusy: calendar.busy, interviews: existing },
        start.getTime(),
        input.source === 'dashboard' ? input.hostOverrides : undefined,
      );
      if (!verdict.available) throw slotConflict(verdict.reason, SLOT_REJECTION_MESSAGES[verdict.reason]);

      const [candidate] = await tx
        .insert(candidates)
        .values({
          organizationId: ctx.organization.id,
          email,
          name: input.candidate.name.trim(),
          phone: cleaned.phone ?? null,
          company: cleaned.company ?? null,
          linkedinUrl: cleaned.linkedinUrl ?? null,
          resumeUrl: cleaned.resumeUrl ?? null,
          timezone: input.candidate.timezone,
        })
        .onConflictDoUpdate({
          target: [candidates.organizationId, candidates.email],
          set: {
            name: sql`excluded.name`,
            phone: sql`coalesce(excluded.phone, ${candidates.phone})`,
            company: sql`coalesce(excluded.company, ${candidates.company})`,
            linkedinUrl: sql`coalesce(excluded.linkedin_url, ${candidates.linkedinUrl})`,
            resumeUrl: sql`coalesce(excluded.resume_url, ${candidates.resumeUrl})`,
            timezone: sql`excluded.timezone`,
            updatedAt: new Date(),
          },
        })
        .returning();

      const end = new Date(start.getTime() + ctx.eventType.durationMinutes * 60_000);
      const [created] = await tx
        .insert(interviews)
        .values({
          organizationId: ctx.organization.id,
          eventTypeId: ctx.eventType.id,
          hostUserId: ctx.host.id,
          candidateId: candidate.id,
          schedulingLinkId: linkId,
          title: `${ctx.eventType.name}: ${candidate.name}`,
          startAt: start,
          endAt: end,
          bufferBeforeMinutes: ctx.eventType.bufferBeforeMinutes,
          bufferAfterMinutes: ctx.eventType.bufferAfterMinutes,
          timezone: ctx.policy.timezone,
          candidateTimezone: input.candidate.timezone,
          status: 'scheduled',
          locationType: ctx.eventType.locationType,
          locationDetails: ctx.eventType.locationDetails,
          responses,
          source: linkId ? 'scheduling_link' : input.source,
          idempotencyKey: input.idempotencyKey ?? null,
        })
        .returning();

      const tokens = await issueBookingTokens(tx, created.id, created.startAt, created.endAt);

      // Integration records — executed by the sync job, visible in the UI immediately.
      const conferencing = LOCATION_CONFERENCING_PROVIDER[created.locationType];
      if (conferencing) {
        await tx.insert(videoMeetings).values({
          organizationId: created.organizationId,
          interviewId: created.id,
          provider: conferencing,
          integrationId: zoomIntegration?.id ?? null,
          status: zoomIntegration ? 'pending' : 'failed',
          lastError: zoomIntegration ? null : 'Zoom is not connected for this interviewer.',
        });
      }
      if (googleIntegration && writeCalendar) {
        await tx.insert(calendarEvents).values({
          organizationId: created.organizationId,
          interviewId: created.id,
          provider: 'google_calendar',
          integrationId: googleIntegration.id,
          externalCalendarId: writeCalendar.externalCalendarId,
          status: 'pending',
        });
      }

      await planBooked(tx, { interview: created, candidate, host: ctx.host, organization: ctx.organization, eventType: ctx.eventType });
      await recordAudit(
        {
          organizationId: created.organizationId,
          actor: input.actor,
          action: 'interview.created',
          resourceType: 'interview',
          resourceId: created.id,
          metadata: {
            eventType: ctx.eventType.name,
            candidateEmail: email,
            start: created.startAt.toISOString(),
            end: created.endAt.toISOString(),
            source: created.source,
          },
          meta: input.meta,
        },
        tx,
      );
      await enqueueInterviewSync(created.id, 'booked', tx);
      return { interview: created, viewToken: tokens.view };
    });
  } catch (err) {
    if (isOverlapViolation(err)) throw slotConflict('interview_conflict');
    if (pgErrorCode(err) === PG_ERRORS.UNIQUE_VIOLATION && pgConstraintName(err) === 'interviews_idempotency_unique' && input.idempotencyKey) {
      const existing = await existingByIdempotencyKey(ctx.eventType.id, input.idempotencyKey);
      if (existing) return { interviewId: existing.id, created: false, viewToken: await viewTokenFor(existing.id) };
    }
    throw err;
  }

  const { interview, viewToken } = outcome;
  if (!viewToken) {
    // Idempotent replay resolved inside the lock.
    return { interviewId: interview.id, created: false, viewToken: await viewTokenFor(interview.id) };
  }
  if (input.inlineSync !== false) await runInlineSync(interview.id);
  return { interviewId: interview.id, created: true, viewToken };
}

// ---------------------------------------------------------------------------------------------
// Reschedule & cancel
// ---------------------------------------------------------------------------------------------

export interface ManageActorInput {
  actor: Actor;
  /** How the action was authorised — candidate token links are subject to organisation policy. */
  via: 'candidate_token' | 'dashboard';
  /** Role label for notifications. */
  actorRole: 'candidate' | 'host' | 'admin';
  meta?: RequestMeta | null;
}

export interface RescheduleInput extends ManageActorInput {
  interviewId: string;
  newStart: Date;
  reason?: string | null;
  candidateTimezone?: string | null;
  hostOverrides?: CheckSlotOptions;
  inlineSync?: boolean;
}

function assertCandidatePolicy(
  ctx: SchedulingContext,
  interview: InterviewRow,
  action: 'reschedule' | 'cancel',
) {
  const s = ctx.organization.settings;
  const allowed = action === 'reschedule' ? s.candidateCanReschedule !== false : s.candidateCanCancel !== false;
  if (!allowed) {
    throw new ForbiddenError(`Online ${action === 'reschedule' ? 'rescheduling' : 'cancellation'} is disabled. Please contact your recruiter.`);
  }
  const cutoff = (s.candidateManageCutoffMinutes ?? 0) * 60_000;
  if (interview.startAt.getTime() - cutoff <= Date.now()) {
    throw new GoneError(
      `This interview can no longer be ${action === 'reschedule' ? 'rescheduled' : 'cancelled'} online. Please contact your recruiter.`,
      'TOO_LATE_TO_CHANGE',
    );
  }
}

function isActive(status: InterviewRow['status']) {
  return (ACTIVE_INTERVIEW_STATUSES as readonly string[]).includes(status);
}

export function interviewConstraints(ctx: SchedulingContext, interview: InterviewRow): EventConstraints {
  return {
    ...ctx.constraints,
    durationMinutes: Math.round((interview.endAt.getTime() - interview.startAt.getTime()) / 60_000),
    bufferBeforeMinutes: interview.bufferBeforeMinutes,
    bufferAfterMinutes: interview.bufferAfterMinutes,
  };
}

export async function rescheduleInterview(input: RescheduleInput): Promise<InterviewRow> {
  const [current] = await db.select().from(interviews).where(eq(interviews.id, input.interviewId)).limit(1);
  if (!current) throw new NotFoundError('Interview not found');
  if (!isActive(current.status)) throw new ConflictError('Only scheduled interviews can be rescheduled.', 'INVALID_STATUS');
  const ctx = await loadSchedulingContext(current.eventTypeId);
  if (input.via === 'candidate_token') assertCandidatePolicy(ctx, current, 'reschedule');
  const newStart = input.newStart;
  if (newStart.getTime() === current.startAt.getTime()) throw new BadRequestError('Choose a different time to reschedule.', 'SAME_TIME');

  const constraints = interviewConstraints(ctx, current);
  const window = loadWindowFor(ctx.policy.timezone, newStart.getTime());
  const calendar = await getAvailability(ctx.host.id, window);
  // The interview's own calendar event shows up as busy — ignore it.
  const busy = subtractRange(calendar.busy, { start: current.startAt.getTime(), end: current.endAt.getTime() });

  let updated: InterviewRow;
  try {
    updated = await db.transaction(async (tx) => {
      await lockHost(tx, current.hostUserId);
      const [locked] = await tx.select().from(interviews).where(eq(interviews.id, current.id)).for('update');
      if (!locked || !isActive(locked.status)) throw new ConflictError('Only scheduled interviews can be rescheduled.', 'INVALID_STATUS');
      if (locked.version !== current.version) throw new ConflictError('This interview was just changed. Please reload and try again.', 'STALE_INTERVIEW');

      const existing = await loadActiveInterviews(current.hostUserId, window, tx);
      const verdict = checkSlot(
        ctx.policy,
        constraints,
        { now: Date.now(), calendarBusy: busy, interviews: existing, excludeInterviewId: current.id },
        newStart.getTime(),
        input.via === 'dashboard' ? input.hostOverrides : undefined,
      );
      if (!verdict.available) throw slotConflict(verdict.reason, SLOT_REJECTION_MESSAGES[verdict.reason]);

      const newEnd = new Date(newStart.getTime() + constraints.durationMinutes * 60_000);
      await tx.insert(interviewReschedules).values({
        organizationId: locked.organizationId,
        interviewId: locked.id,
        previousStartAt: locked.startAt,
        previousEndAt: locked.endAt,
        newStartAt: newStart,
        newEndAt: newEnd,
        actorType: input.actor.type,
        actorUserId: input.actor.type === 'user' ? input.actor.userId : null,
        reason: input.reason?.trim() || null,
      });
      const [row] = await tx
        .update(interviews)
        .set({
          startAt: newStart,
          endAt: newEnd,
          status: 'rescheduled',
          version: locked.version + 1,
          rescheduleCount: locked.rescheduleCount + 1,
          candidateTimezone: input.candidateTimezone ?? locked.candidateTimezone,
          updatedAt: new Date(),
        })
        .where(eq(interviews.id, locked.id))
        .returning();
      await updateTokenExpiries(tx, row.id, row.startAt, row.endAt);

      const [candidate] = await tx.select().from(candidates).where(eq(candidates.id, row.candidateId));
      await planRescheduled(tx, {
        interview: row,
        candidate,
        host: ctx.host,
        organization: ctx.organization,
        eventType: ctx.eventType,
        previous: { start: locked.startAt, end: locked.endAt },
        rescheduledBy: input.actorRole,
        reason: input.reason?.trim() || null,
      });
      await recordAudit(
        {
          organizationId: row.organizationId,
          actor: input.actor,
          action: 'interview.rescheduled',
          resourceType: 'interview',
          resourceId: row.id,
          metadata: {
            previousStart: locked.startAt.toISOString(),
            newStart: row.startAt.toISOString(),
            reason: input.reason?.trim() || null,
            via: input.via,
          },
          meta: input.meta,
        },
        tx,
      );
      await enqueueInterviewSync(row.id, 'rescheduled', tx);
      return row;
    });
  } catch (err) {
    if (isOverlapViolation(err)) throw slotConflict('interview_conflict');
    throw err;
  }
  if (input.inlineSync !== false) await runInlineSync(updated.id);
  return updated;
}

export interface CancelInput extends ManageActorInput {
  interviewId: string;
  reason?: string | null;
  inlineSync?: boolean;
}

export async function cancelInterview(input: CancelInput): Promise<InterviewRow> {
  const [current] = await db.select().from(interviews).where(eq(interviews.id, input.interviewId)).limit(1);
  if (!current) throw new NotFoundError('Interview not found');
  if (current.status === 'cancelled') throw new ConflictError('This interview is already cancelled.', 'ALREADY_CANCELLED');
  if (!isActive(current.status)) throw new ConflictError('Only scheduled interviews can be cancelled.', 'INVALID_STATUS');
  const ctx = await loadSchedulingContext(current.eventTypeId);
  if (input.via === 'candidate_token') assertCandidatePolicy(ctx, current, 'cancel');

  const updated = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(interviews).where(eq(interviews.id, current.id)).for('update');
    if (!locked || locked.status === 'cancelled') throw new ConflictError('This interview is already cancelled.', 'ALREADY_CANCELLED');
    if (!isActive(locked.status)) throw new ConflictError('Only scheduled interviews can be cancelled.', 'INVALID_STATUS');
    const reason = input.reason?.trim() || null;
    const [row] = await tx
      .update(interviews)
      .set({
        status: 'cancelled',
        cancelReason: reason,
        cancelledAt: new Date(),
        cancelledByType: input.actor.type,
        cancelledByUserId: input.actor.type === 'user' ? input.actor.userId : null,
        version: locked.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(interviews.id, locked.id))
      .returning();
    await revokeBookingTokens(tx, row.id, ['reschedule', 'cancel']);
    const [candidate] = await tx.select().from(candidates).where(eq(candidates.id, row.candidateId));
    await planCancelled(tx, {
      interview: row,
      candidate,
      host: ctx.host,
      organization: ctx.organization,
      eventType: ctx.eventType,
      cancelledBy: input.actorRole,
      reason,
    });
    await recordAudit(
      {
        organizationId: row.organizationId,
        actor: input.actor,
        action: 'interview.cancelled',
        resourceType: 'interview',
        resourceId: row.id,
        metadata: { reason, via: input.via, start: row.startAt.toISOString() },
        meta: input.meta,
      },
      tx,
    );
    await enqueueInterviewSync(row.id, 'cancelled', tx);
    return row;
  });
  if (input.inlineSync !== false) await runInlineSync(updated.id);
  return updated;
}

/** Completed / no-show marking after the interview has taken place. */
export async function setInterviewOutcome(
  interviewId: string,
  status: 'completed' | 'no_show',
  actor: Actor,
  meta?: RequestMeta | null,
) {
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(interviews).where(eq(interviews.id, interviewId)).for('update');
    if (!locked) throw new NotFoundError('Interview not found');
    if (locked.status === 'cancelled') throw new ConflictError('Cancelled interviews cannot be marked as completed or no-show.', 'INVALID_STATUS');
    if (locked.startAt.getTime() > Date.now()) {
      throw new ConflictError('An interview can only be marked after it has started.', 'NOT_STARTED');
    }
    const [row] = await tx
      .update(interviews)
      .set({ status, completedAt: status === 'completed' ? (locked.completedAt ?? new Date()) : locked.completedAt, updatedAt: new Date() })
      .where(eq(interviews.id, interviewId))
      .returning();
    await recordAudit(
      {
        organizationId: row.organizationId,
        actor,
        action: 'interview.status_changed',
        resourceType: 'interview',
        resourceId: row.id,
        metadata: { from: locked.status, to: status },
        meta,
      },
      tx,
    );
    return row;
  });
}

/** Loads host/event data needed to present an interview to its candidate. */
export async function loadInterviewForCandidate(interviewId: string) {
  const [row] = await db
    .select({ interview: interviews, eventType: eventTypes, host: users, candidate: candidates })
    .from(interviews)
    .innerJoin(eventTypes, eq(eventTypes.id, interviews.eventTypeId))
    .innerJoin(users, eq(users.id, interviews.hostUserId))
    .innerJoin(candidates, eq(candidates.id, interviews.candidateId))
    .where(eq(interviews.id, interviewId))
    .limit(1);
  return row ?? null;
}
