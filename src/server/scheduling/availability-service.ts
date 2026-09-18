import { and, asc, eq, gt, inArray, isNull, lt } from 'drizzle-orm';
import { db, type Executor } from '../db/client';
import {
  availabilityOverrides,
  availabilityRules,
  availabilitySchedules,
  eventTypes,
  interviews,
  memberships,
  organizationHolidays,
  organizations,
  users,
} from '../db/schema';
import { NotFoundError } from '../http/errors';
import { getAvailability } from '../integrations/service';
import {
  computeAvailableSlots,
  MAX_BUFFER_MINUTES,
  MINUTE,
  type AvailabilityPolicy,
  type EventConstraints,
  type ExistingInterview,
  type TimeRange,
} from './engine';

/**
 * Loads everything the pure engine needs from the database and connected calendars.
 */

export type EventTypeRow = typeof eventTypes.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type OrganizationRow = typeof organizations.$inferSelect;
export type ScheduleRow = typeof availabilitySchedules.$inferSelect;

export interface SchedulingContext {
  eventType: EventTypeRow;
  host: UserRow;
  organization: OrganizationRow;
  hostMembershipActive: boolean;
  schedule: ScheduleRow | null;
  policy: AvailabilityPolicy;
  constraints: EventConstraints;
}

export const ACTIVE_INTERVIEW_STATUSES = ['scheduled', 'rescheduled'] as const;

export async function loadPolicy(
  scheduleId: string | null,
  organizationId: string,
  fallbackTimezone: string,
  executor: Executor = db,
): Promise<{ schedule: ScheduleRow | null; policy: AvailabilityPolicy }> {
  const holidays = await executor
    .select({ date: organizationHolidays.date })
    .from(organizationHolidays)
    .where(eq(organizationHolidays.organizationId, organizationId));
  if (!scheduleId) {
    return { schedule: null, policy: { timezone: fallbackTimezone, weeklyRules: [], overrides: [], blockedDates: holidays.map((h) => h.date) } };
  }
  const [schedule] = await executor.select().from(availabilitySchedules).where(eq(availabilitySchedules.id, scheduleId)).limit(1);
  if (!schedule) {
    return { schedule: null, policy: { timezone: fallbackTimezone, weeklyRules: [], overrides: [], blockedDates: holidays.map((h) => h.date) } };
  }
  const [rules, overrides] = await Promise.all([
    executor.select().from(availabilityRules).where(eq(availabilityRules.scheduleId, schedule.id)),
    executor.select().from(availabilityOverrides).where(eq(availabilityOverrides.scheduleId, schedule.id)),
  ]);
  return {
    schedule,
    policy: {
      timezone: schedule.timezone,
      weeklyRules: rules.map((r) => ({ weekday: r.weekday, startMinute: r.startMinute, endMinute: r.endMinute })),
      overrides: overrides.map((o) => ({ date: o.date, startMinute: o.startMinute, endMinute: o.endMinute })),
      blockedDates: holidays.map((h) => h.date),
    },
  };
}

export async function defaultScheduleId(userId: string, organizationId: string, executor: Executor = db) {
  const [row] = await executor
    .select({ id: availabilitySchedules.id })
    .from(availabilitySchedules)
    .where(
      and(
        eq(availabilitySchedules.userId, userId),
        eq(availabilitySchedules.organizationId, organizationId),
        eq(availabilitySchedules.isDefault, true),
      ),
    )
    .limit(1);
  if (row) return row.id;
  const [any] = await executor
    .select({ id: availabilitySchedules.id })
    .from(availabilitySchedules)
    .where(and(eq(availabilitySchedules.userId, userId), eq(availabilitySchedules.organizationId, organizationId)))
    .orderBy(asc(availabilitySchedules.createdAt))
    .limit(1);
  return any?.id ?? null;
}

export function constraintsFor(eventType: EventTypeRow): EventConstraints {
  return {
    durationMinutes: eventType.durationMinutes,
    slotIntervalMinutes: eventType.slotIntervalMinutes,
    bufferBeforeMinutes: eventType.bufferBeforeMinutes,
    bufferAfterMinutes: eventType.bufferAfterMinutes,
    minimumNoticeMinutes: eventType.minimumNoticeMinutes,
    maxDaysInFuture: eventType.maxDaysInFuture,
    dailyLimit: eventType.dailyLimit,
  };
}

export async function loadSchedulingContext(eventTypeId: string, executor: Executor = db): Promise<SchedulingContext> {
  const [row] = await executor
    .select({ eventType: eventTypes, host: users, organization: organizations })
    .from(eventTypes)
    .innerJoin(users, eq(users.id, eventTypes.hostUserId))
    .innerJoin(organizations, eq(organizations.id, eventTypes.organizationId))
    .where(and(eq(eventTypes.id, eventTypeId), isNull(eventTypes.deletedAt)))
    .limit(1);
  if (!row) throw new NotFoundError('Event type not found');
  const [membership] = await executor
    .select({ status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.userId, row.host.id), eq(memberships.organizationId, row.organization.id)))
    .limit(1);
  const scheduleId = row.eventType.scheduleId ?? (await defaultScheduleId(row.host.id, row.organization.id, executor));
  const { schedule, policy } = await loadPolicy(scheduleId, row.organization.id, row.host.timezone, executor);
  return {
    eventType: row.eventType,
    host: row.host,
    organization: row.organization,
    hostMembershipActive: membership?.status === 'active',
    schedule,
    policy,
    constraints: constraintsFor(row.eventType),
  };
}

/** Active interviews for a host that could interact with the given range (buffers included). */
export async function loadActiveInterviews(hostUserId: string, range: TimeRange, executor: Executor = db): Promise<ExistingInterview[]> {
  const margin = MAX_BUFFER_MINUTES * MINUTE;
  const rows = await executor
    .select({
      id: interviews.id,
      startAt: interviews.startAt,
      endAt: interviews.endAt,
      bufferBeforeMinutes: interviews.bufferBeforeMinutes,
      bufferAfterMinutes: interviews.bufferAfterMinutes,
    })
    .from(interviews)
    .where(
      and(
        eq(interviews.hostUserId, hostUserId),
        inArray(interviews.status, [...ACTIVE_INTERVIEW_STATUSES]),
        lt(interviews.startAt, new Date(range.end + margin)),
        gt(interviews.endAt, new Date(range.start - margin)),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    start: r.startAt.getTime(),
    end: r.endAt.getTime(),
    bufferBeforeMinutes: r.bufferBeforeMinutes,
    bufferAfterMinutes: r.bufferAfterMinutes,
  }));
}

/** Removes `cut` from every busy block (used to ignore an interview's own calendar event). */
export function subtractRange(busy: TimeRange[], cut: TimeRange | null): TimeRange[] {
  if (!cut) return busy;
  const out: TimeRange[] = [];
  for (const b of busy) {
    if (b.end <= cut.start || b.start >= cut.end) {
      out.push(b);
      continue;
    }
    if (b.start < cut.start) out.push({ start: b.start, end: cut.start });
    if (b.end > cut.end) out.push({ start: cut.end, end: b.end });
  }
  return out;
}

export const MAX_AVAILABILITY_RANGE_DAYS = 62;

export interface SlotsQuery {
  eventTypeId: string;
  rangeStart: Date;
  rangeEnd: Date;
  /** When rescheduling: ignore this interview (and its own calendar event). */
  exclude?: { interviewId: string; start: Date; end: Date } | null;
  /** Rescheduling keeps the interview's own duration and buffers. */
  overrides?: Partial<Pick<EventConstraints, 'durationMinutes' | 'bufferBeforeMinutes' | 'bufferAfterMinutes'>>;
  now?: number;
}

export interface SlotsResult {
  timezone: string;
  durationMinutes: number;
  slots: { start: string; end: string }[];
  calendarConnected: boolean;
}

/** Bookable slots for browsing (public page, reschedule pickers). */
export async function getBookableSlots(q: SlotsQuery): Promise<SlotsResult> {
  const ctx = await loadSchedulingContext(q.eventTypeId);
  const now = q.now ?? Date.now();
  const rangeStart = Math.max(q.rangeStart.getTime(), now);
  const rangeEnd = Math.min(q.rangeEnd.getTime(), rangeStart + MAX_AVAILABILITY_RANGE_DAYS * 24 * 60 * MINUTE);
  const constraints = { ...ctx.constraints, ...q.overrides };
  if (rangeEnd <= rangeStart) {
    return { timezone: ctx.policy.timezone, durationMinutes: constraints.durationMinutes, slots: [], calendarConnected: false };
  }
  const window: TimeRange = { start: rangeStart - 24 * 60 * MINUTE, end: rangeEnd + 24 * 60 * MINUTE };
  const [calendar, existing] = await Promise.all([
    getAvailability(ctx.host.id, window, { allowCache: true }),
    loadActiveInterviews(ctx.host.id, window),
  ]);
  const busy = q.exclude ? subtractRange(calendar.busy, { start: q.exclude.start.getTime(), end: q.exclude.end.getTime() }) : calendar.busy;
  const slots = computeAvailableSlots(ctx.policy, constraints, {
    now,
    calendarBusy: busy,
    interviews: existing,
    excludeInterviewId: q.exclude?.interviewId ?? null,
    rangeStart,
    rangeEnd,
  });
  return {
    timezone: ctx.policy.timezone,
    durationMinutes: constraints.durationMinutes,
    slots: slots.map((s) => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString() })),
    calendarConnected: calendar.connected,
  };
}
