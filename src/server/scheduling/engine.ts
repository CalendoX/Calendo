import { DateTime } from 'luxon';

/**
 * Calendor scheduling engine.
 *
 * A pure, dependency-free (apart from Luxon for IANA time-zone math) module that answers two
 * questions:
 *
 *   1. Which start times can be offered for an event type in a given window?  (computeAvailableSlots)
 *   2. Is one specific start time bookable right now, and if not, why?        (checkSlot)
 *
 * Both answers come from the same code path so the booking-time re-check can never disagree
 * with what the public page offered.
 *
 * All instants are epoch milliseconds (UTC). Working hours are expressed as wall-clock minutes
 * in the schedule's IANA zone and converted per calendar date, which makes daylight-saving
 * transitions come out right (a 09:00–17:00 day is 09:00–17:00 local on both sides of a change).
 *
 * Conflict semantics
 * ------------------
 * An event's buffers must be free of other *meetings*, but buffers may overlap each other:
 *   - the new slot's padded range  [start − before, end + after)  must not overlap any existing
 *     interview's meeting time or any external calendar busy block, and
 *   - the new slot's meeting time  [start, end)  must not overlap any existing interview's
 *     padded range.
 * E.g. an interview 10:00–11:00 with a 15 minute after-buffer blocks new meetings until 11:15.
 */

export const MINUTE = 60_000;
export const DAY_MINUTES = 1440;
/** Buffers are capped at 4 hours (also enforced by a database CHECK constraint). */
export const MAX_BUFFER_MINUTES = 240;

export interface TimeRange {
  /** Inclusive start, epoch ms. */
  start: number;
  /** Exclusive end, epoch ms. */
  end: number;
}

export interface WeeklyRule {
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  weekday: number;
  startMinute: number;
  endMinute: number;
}

export interface DateOverride {
  /** Local date in the schedule zone, YYYY-MM-DD. */
  date: string;
  /** Both null => the whole date is unavailable. */
  startMinute: number | null;
  endMinute: number | null;
}

export interface AvailabilityPolicy {
  timezone: string;
  weeklyRules: WeeklyRule[];
  overrides: DateOverride[];
  /** Organisation holidays / blackout dates (local dates in the schedule zone). */
  blockedDates?: string[];
}

export interface EventConstraints {
  durationMinutes: number;
  /** Spacing between offered start times; defaults to min(duration, 30). */
  slotIntervalMinutes?: number | null;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minimumNoticeMinutes: number;
  /** Rolling booking window in days from today (schedule zone); null = unlimited. */
  maxDaysInFuture?: number | null;
  /** Maximum interviews per local day for the host; null = unlimited. */
  dailyLimit?: number | null;
}

export interface ExistingInterview {
  id: string;
  start: number;
  end: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
}

export interface BusyContext {
  now: number;
  /** Busy blocks from external calendars (already expanded to absolute instants). */
  calendarBusy: TimeRange[];
  /** The host's active (scheduled / rescheduled) interviews. */
  interviews: ExistingInterview[];
  /** Interview being rescheduled — its current time must not conflict with itself. */
  excludeInterviewId?: string | null;
}

export type SlotRejection =
  | 'invalid_time'
  | 'outside_availability'
  | 'too_soon'
  | 'too_far'
  | 'interview_conflict'
  | 'calendar_conflict'
  | 'daily_limit';

export const SLOT_REJECTION_MESSAGES: Record<SlotRejection, string> = {
  invalid_time: 'The requested time is invalid.',
  outside_availability: "The requested time is outside the interviewer's availability.",
  too_soon: 'The requested time is too soon to book.',
  too_far: 'The requested time is too far in the future to book.',
  interview_conflict: 'The requested time is no longer available.',
  calendar_conflict: 'The requested time is no longer available.',
  daily_limit: 'The interviewer has reached their daily interview limit for that day.',
};

export interface CheckSlotOptions {
  /** Hosts/admins rescheduling may pick a time outside working hours or off the slot grid. */
  ignoreWorkingHours?: boolean;
  /** Hosts/admins may ignore minimum notice and the rolling window. */
  ignoreNotice?: boolean;
}

export type SlotCheckResult = { available: true } | { available: false; reason: SlotRejection };

// ---------------------------------------------------------------------------------------------
// Time-zone helpers
// ---------------------------------------------------------------------------------------------

export function isValidTimeZone(zone: string): boolean {
  if (!zone) return false;
  return DateTime.local().setZone(zone).isValid;
}

/** Converts a local wall-clock time (date + minutes since midnight) in `zone` to epoch ms. */
export function localMinuteToInstant(date: string, minute: number, zone: string): number {
  const day = DateTime.fromISO(date, { zone });
  if (!day.isValid) throw new Error(`Invalid date ${date} in zone ${zone}`);
  if (minute >= DAY_MINUTES) {
    // 24:00 == next day's local midnight (calendar math, so DST-safe).
    const next = day.plus({ days: 1 });
    return DateTime.fromObject({ year: next.year, month: next.month, day: next.day }, { zone }).toMillis();
  }
  // Build from components rather than adding minutes to midnight: on DST days midnight + 9h
  // is *not* 09:00 local. Non-existent local times (spring-forward gap) are shifted forward.
  return DateTime.fromObject(
    { year: day.year, month: day.month, day: day.day, hour: Math.floor(minute / 60), minute: minute % 60 },
    { zone },
  ).toMillis();
}

export function localDateOf(instant: number, zone: string): string {
  return DateTime.fromMillis(instant, { zone }).toISODate()!;
}

function addDays(date: string, days: number): string {
  return DateTime.fromISO(date, { zone: 'UTC' }).plus({ days }).toISODate()!;
}

function isoWeekday(date: string): number {
  return DateTime.fromISO(date, { zone: 'UTC' }).weekday;
}

function overlaps(a: TimeRange, b: TimeRange): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Sorts and merges overlapping/adjacent ranges. */
export function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Working windows
// ---------------------------------------------------------------------------------------------

export interface WorkingWindow extends TimeRange {
  /** Local date (schedule zone) the window belongs to. */
  date: string;
}

/** Working windows for each local date in [fromDate, toDate] (inclusive), in the schedule zone. */
export function workingWindows(policy: AvailabilityPolicy, fromDate: string, toDate: string): WorkingWindow[] {
  const blocked = new Set(policy.blockedDates ?? []);
  const overridesByDate = new Map<string, DateOverride[]>();
  for (const o of policy.overrides) {
    const list = overridesByDate.get(o.date) ?? [];
    list.push(o);
    overridesByDate.set(o.date, list);
  }
  const rulesByWeekday = new Map<number, WeeklyRule[]>();
  for (const r of policy.weeklyRules) {
    const list = rulesByWeekday.get(r.weekday) ?? [];
    list.push(r);
    rulesByWeekday.set(r.weekday, list);
  }

  const windows: WorkingWindow[] = [];
  for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
    if (blocked.has(date)) continue;
    const overrides = overridesByDate.get(date);
    let intervals: { startMinute: number; endMinute: number }[];
    if (overrides && overrides.length > 0) {
      if (overrides.some((o) => o.startMinute === null || o.endMinute === null)) continue; // day off
      intervals = overrides.map((o) => ({ startMinute: o.startMinute!, endMinute: o.endMinute! }));
    } else {
      intervals = rulesByWeekday.get(isoWeekday(date)) ?? [];
    }
    const ranges = intervals
      .filter((i) => i.endMinute > i.startMinute)
      .map((i) => ({
        start: localMinuteToInstant(date, Math.max(0, i.startMinute), policy.timezone),
        end: localMinuteToInstant(date, Math.min(DAY_MINUTES, i.endMinute), policy.timezone),
      }));
    for (const r of mergeRanges(ranges)) windows.push({ ...r, date });
  }
  return windows;
}

// ---------------------------------------------------------------------------------------------
// Slot evaluation
// ---------------------------------------------------------------------------------------------

export function effectiveSlotInterval(event: EventConstraints): number {
  const interval = event.slotIntervalMinutes ?? Math.min(event.durationMinutes, 30);
  return Math.max(5, interval);
}

interface PreparedContext {
  policy: AvailabilityPolicy;
  event: EventConstraints;
  now: number;
  calendarBusy: TimeRange[];
  interviews: ExistingInterview[];
  lastBookableDate: string | null;
  interviewsPerDate: Map<string, number>;
}

function prepare(policy: AvailabilityPolicy, event: EventConstraints, ctx: BusyContext): PreparedContext {
  const interviews = ctx.interviews
    .filter((i) => i.id !== ctx.excludeInterviewId)
    .sort((a, b) => a.start - b.start);
  const interviewsPerDate = new Map<string, number>();
  for (const i of interviews) {
    const d = localDateOf(i.start, policy.timezone);
    interviewsPerDate.set(d, (interviewsPerDate.get(d) ?? 0) + 1);
  }
  const today = localDateOf(ctx.now, policy.timezone);
  return {
    policy,
    event,
    now: ctx.now,
    calendarBusy: mergeRanges(ctx.calendarBusy),
    interviews,
    lastBookableDate:
      event.maxDaysInFuture === null || event.maxDaysInFuture === undefined ? null : addDays(today, event.maxDaysInFuture),
    interviewsPerDate,
  };
}

function evaluate(
  p: PreparedContext,
  start: number,
  localDate: string,
  options: CheckSlotOptions = {},
): SlotRejection | null {
  const { event } = p;
  const end = start + event.durationMinutes * MINUTE;
  if (!options.ignoreNotice) {
    if (start < p.now + event.minimumNoticeMinutes * MINUTE) return 'too_soon';
    if (p.lastBookableDate && localDate > p.lastBookableDate) return 'too_far';
  } else if (start < p.now) {
    return 'too_soon';
  }

  const core: TimeRange = { start, end };
  const padded: TimeRange = {
    start: start - event.bufferBeforeMinutes * MINUTE,
    end: end + event.bufferAfterMinutes * MINUTE,
  };

  for (const i of p.interviews) {
    // Sorted by start and buffers are capped, so nothing from here on can reach our range.
    if (i.start >= padded.end + MAX_BUFFER_MINUTES * MINUTE) break;
    const iCore: TimeRange = { start: i.start, end: i.end };
    const iPadded: TimeRange = {
      start: i.start - i.bufferBeforeMinutes * MINUTE,
      end: i.end + i.bufferAfterMinutes * MINUTE,
    };
    if (overlaps(padded, iCore) || overlaps(core, iPadded)) return 'interview_conflict';
  }

  for (const b of p.calendarBusy) {
    if (b.start >= padded.end) break;
    if (overlaps(padded, b)) return 'calendar_conflict';
  }

  if (event.dailyLimit !== null && event.dailyLimit !== undefined) {
    if ((p.interviewsPerDate.get(localDate) ?? 0) >= event.dailyLimit) return 'daily_limit';
  }
  return null;
}

function* gridSlots(windows: WorkingWindow[], event: EventConstraints) {
  const step = effectiveSlotInterval(event) * MINUTE;
  const duration = event.durationMinutes * MINUTE;
  for (const w of windows) {
    for (let t = w.start; t + duration <= w.end; t += step) {
      yield { start: t, end: t + duration, date: w.date };
    }
  }
}

/**
 * All bookable slots whose start lies in [rangeStart, rangeEnd).
 */
export function computeAvailableSlots(
  policy: AvailabilityPolicy,
  event: EventConstraints,
  ctx: BusyContext & { rangeStart: number; rangeEnd: number },
): TimeRange[] {
  if (ctx.rangeEnd <= ctx.rangeStart) return [];
  const p = prepare(policy, event, ctx);
  // Scan one extra local day each side: a window on the previous local date may start inside
  // the range once converted to UTC.
  let fromDate = addDays(localDateOf(Math.max(ctx.rangeStart, ctx.now), policy.timezone), -1);
  let toDate = addDays(localDateOf(ctx.rangeEnd, policy.timezone), 1);
  const today = localDateOf(ctx.now, policy.timezone);
  if (fromDate < addDays(today, -1)) fromDate = addDays(today, -1);
  if (p.lastBookableDate && toDate > p.lastBookableDate) toDate = p.lastBookableDate;
  if (toDate < fromDate) return [];

  const slots: TimeRange[] = [];
  for (const slot of gridSlots(workingWindows(policy, fromDate, toDate), event)) {
    if (slot.start < ctx.rangeStart || slot.start >= ctx.rangeEnd) continue;
    if (evaluate(p, slot.start, slot.date) === null) slots.push({ start: slot.start, end: slot.end });
  }
  return slots;
}

/**
 * Authoritative availability check for one start time. Used immediately before a booking or
 * reschedule is written (inside the per-host lock).
 */
export function checkSlot(
  policy: AvailabilityPolicy,
  event: EventConstraints,
  ctx: BusyContext,
  start: number,
  options: CheckSlotOptions = {},
): SlotCheckResult {
  if (!Number.isFinite(start)) return { available: false, reason: 'invalid_time' };
  const p = prepare(policy, event, ctx);
  const localDate = localDateOf(start, policy.timezone);

  if (!options.ignoreWorkingHours) {
    const windows = workingWindows(policy, addDays(localDate, -1), addDays(localDate, 1));
    let onGrid = false;
    let windowDate = localDate;
    for (const slot of gridSlots(windows, event)) {
      if (slot.start === start) {
        onGrid = true;
        windowDate = slot.date;
        break;
      }
    }
    if (!onGrid) return { available: false, reason: 'outside_availability' };
    const reason = evaluate(p, start, windowDate, options);
    return reason ? { available: false, reason } : { available: true };
  }

  if (start % MINUTE !== 0) return { available: false, reason: 'invalid_time' };
  const reason = evaluate(p, start, localDate, options);
  return reason ? { available: false, reason } : { available: true };
}

/**
 * The instant range whose interviews and calendar busy blocks can influence a check of `start`:
 * the whole local day (for daily limits) widened by a day on each side (buffers, windows that
 * straddle midnight in UTC).
 */
export function loadWindowFor(timezone: string, start: number): TimeRange {
  const local = DateTime.fromMillis(start, { zone: timezone });
  return {
    start: local.startOf('day').minus({ days: 1 }).toMillis(),
    end: local.endOf('day').plus({ days: 1 }).toMillis(),
  };
}
