import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthContext } from '../auth/session';
import { assertOwner } from '../authz/policy';
import { db } from '../db/client';
import { availabilityOverrides, availabilityRules, availabilitySchedules, eventTypes } from '../db/schema';
import { BadRequestError, NotFoundError, ValidationError } from '../http/errors';
import type { RequestMeta } from '../http/request';
import { zTimeZone } from '../http/validation';
import { recordAudit } from './audit';
import { minutesToTime, timeToMinutes } from '@/lib/format';

/** Availability schedules: weekly working hours, date overrides and time zone. Owner-only. */

const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Use HH:MM');
const zInterval = z.object({ start: zTime, end: zTime });

export const ScheduleInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  timezone: zTimeZone,
  weekly: z
    .array(z.object({ weekday: z.number().int().min(1).max(7), intervals: z.array(zInterval).max(8) }))
    .max(7),
  overrides: z
    .array(
      z.object({
        date: z.iso.date(),
        /** Empty array = unavailable all day. */
        intervals: z.array(zInterval).max(8),
        note: z.string().trim().max(200).nullish(),
      }),
    )
    .max(366)
    .default([]),
});

export type ScheduleInput = z.infer<typeof ScheduleInputSchema>;

function toMinuteIntervals(intervals: { start: string; end: string }[], path: string, errors: Record<string, string[]>) {
  const out = intervals.map((i) => ({ start: timeToMinutes(i.start)!, end: timeToMinutes(i.end)! }));
  out.sort((a, b) => a.start - b.start);
  out.forEach((i, idx) => {
    if (i.end <= i.start) (errors[path] ??= []).push(`${minutesToTime(i.start)}–${minutesToTime(i.end)}: end must be after start`);
    const next = out[idx + 1];
    if (next && next.start < i.end) (errors[path] ??= []).push('Time ranges overlap');
  });
  return out;
}

export interface ScheduleDto {
  id: string;
  name: string;
  timezone: string;
  isDefault: boolean;
  weekly: { weekday: number; intervals: { start: string; end: string }[] }[];
  overrides: { date: string; intervals: { start: string; end: string }[]; note: string | null }[];
  eventTypeCount: number;
}

async function toDto(schedule: typeof availabilitySchedules.$inferSelect): Promise<ScheduleDto> {
  const [rules, overrides, [usage]] = await Promise.all([
    db.select().from(availabilityRules).where(eq(availabilityRules.scheduleId, schedule.id)).orderBy(asc(availabilityRules.startMinute)),
    db.select().from(availabilityOverrides).where(eq(availabilityOverrides.scheduleId, schedule.id)).orderBy(asc(availabilityOverrides.date)),
    db.select({ n: count() }).from(eventTypes).where(and(eq(eventTypes.scheduleId, schedule.id), isNull(eventTypes.deletedAt))),
  ]);
  const weekly = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    intervals: rules
      .filter((r) => r.weekday === weekday)
      .map((r) => ({ start: minutesToTime(r.startMinute), end: minutesToTime(r.endMinute) })),
  }));
  const byDate = new Map<string, ScheduleDto['overrides'][number]>();
  for (const o of overrides) {
    const entry = byDate.get(o.date) ?? { date: o.date, intervals: [], note: o.note };
    if (o.startMinute !== null && o.endMinute !== null) entry.intervals.push({ start: minutesToTime(o.startMinute), end: minutesToTime(o.endMinute) });
    byDate.set(o.date, entry);
  }
  return {
    id: schedule.id,
    name: schedule.name,
    timezone: schedule.timezone,
    isDefault: schedule.isDefault,
    weekly,
    overrides: [...byDate.values()],
    eventTypeCount: Number(usage?.n ?? 0),
  };
}

async function loadOwned(ctx: AuthContext, id: string) {
  const [row] = await db.select().from(availabilitySchedules).where(eq(availabilitySchedules.id, id)).limit(1);
  if (!row) throw new NotFoundError('Schedule not found');
  assertOwner(ctx, row, 'Schedule');
  return row;
}

export async function listSchedules(ctx: AuthContext): Promise<ScheduleDto[]> {
  const rows = await db
    .select()
    .from(availabilitySchedules)
    .where(and(eq(availabilitySchedules.userId, ctx.user.id), eq(availabilitySchedules.organizationId, ctx.organization.id)))
    .orderBy(asc(availabilitySchedules.createdAt));
  return Promise.all(rows.map(toDto));
}

export async function getSchedule(ctx: AuthContext, id: string) {
  return toDto(await loadOwned(ctx, id));
}

export async function createSchedule(ctx: AuthContext, input: { name: string; timezone: string; copyFromId?: string | null }, meta: RequestMeta) {
  const source = input.copyFromId ? await getSchedule(ctx, input.copyFromId) : null;
  const [existing] = await db
    .select({ n: count() })
    .from(availabilitySchedules)
    .where(and(eq(availabilitySchedules.userId, ctx.user.id), eq(availabilitySchedules.organizationId, ctx.organization.id)));
  if (Number(existing?.n ?? 0) >= 20) throw new BadRequestError('You can have at most 20 schedules.');
  const row = await db.transaction(async (tx) => {
    const [s] = await tx
      .insert(availabilitySchedules)
      .values({
        organizationId: ctx.organization.id,
        userId: ctx.user.id,
        name: input.name.trim(),
        timezone: input.timezone,
        isDefault: Number(existing?.n ?? 0) === 0,
      })
      .returning();
    const weekly = source?.weekly ?? [1, 2, 3, 4, 5].map((weekday) => ({ weekday, intervals: [{ start: '09:00', end: '17:00' }] }));
    const rules = weekly.flatMap((d) =>
      d.intervals.map((i) => ({ scheduleId: s.id, weekday: d.weekday, startMinute: timeToMinutes(i.start)!, endMinute: timeToMinutes(i.end)! })),
    );
    if (rules.length) await tx.insert(availabilityRules).values(rules);
    await recordAudit(
      { organizationId: ctx.organization.id, actor: { type: 'user', userId: ctx.user.id }, action: 'availability.created', resourceType: 'availability_schedule', resourceId: s.id, metadata: { name: s.name }, meta },
      tx,
    );
    return s;
  });
  return toDto(row);
}

export async function updateSchedule(ctx: AuthContext, id: string, input: ScheduleInput, meta: RequestMeta) {
  const schedule = await loadOwned(ctx, id);
  const errors: Record<string, string[]> = {};
  const weekdaysSeen = new Set<number>();
  const rules: { weekday: number; start: number; end: number }[] = [];
  for (const day of input.weekly) {
    if (weekdaysSeen.has(day.weekday)) (errors[`weekly.${day.weekday}`] ??= []).push('Duplicate day');
    weekdaysSeen.add(day.weekday);
    for (const i of toMinuteIntervals(day.intervals, `weekly.${day.weekday}`, errors)) rules.push({ weekday: day.weekday, ...i });
  }
  const datesSeen = new Set<string>();
  const overrides: { date: string; start: number | null; end: number | null; note: string | null }[] = [];
  for (const o of input.overrides) {
    if (datesSeen.has(o.date)) (errors[`overrides.${o.date}`] ??= []).push('Duplicate date');
    datesSeen.add(o.date);
    if (o.intervals.length === 0) overrides.push({ date: o.date, start: null, end: null, note: o.note ?? null });
    for (const i of toMinuteIntervals(o.intervals, `overrides.${o.date}`, errors)) overrides.push({ date: o.date, start: i.start, end: i.end, note: o.note ?? null });
  }
  if (Object.keys(errors).length) throw new ValidationError('Please fix the highlighted times.', errors);

  await db.transaction(async (tx) => {
    await tx
      .update(availabilitySchedules)
      .set({ name: input.name, timezone: input.timezone, updatedAt: new Date() })
      .where(eq(availabilitySchedules.id, id));
    await tx.delete(availabilityRules).where(eq(availabilityRules.scheduleId, id));
    await tx.delete(availabilityOverrides).where(eq(availabilityOverrides.scheduleId, id));
    if (rules.length) {
      await tx.insert(availabilityRules).values(rules.map((r) => ({ scheduleId: id, weekday: r.weekday, startMinute: r.start, endMinute: r.end })));
    }
    if (overrides.length) {
      await tx
        .insert(availabilityOverrides)
        .values(overrides.map((o) => ({ scheduleId: id, date: o.date, startMinute: o.start, endMinute: o.end, note: o.note })));
    }
    await recordAudit(
      {
        organizationId: ctx.organization.id,
        actor: { type: 'user', userId: ctx.user.id },
        action: 'availability.updated',
        resourceType: 'availability_schedule',
        resourceId: id,
        metadata: {
          name: input.name,
          timezone: input.timezone,
          previousTimezone: schedule.timezone !== input.timezone ? schedule.timezone : undefined,
          weeklyRanges: rules.length,
          overrides: datesSeen.size,
        },
        meta,
      },
      tx,
    );
  });
  return getSchedule(ctx, id);
}

export async function setDefaultSchedule(ctx: AuthContext, id: string) {
  await loadOwned(ctx, id);
  await db.transaction(async (tx) => {
    await tx
      .update(availabilitySchedules)
      .set({ isDefault: false })
      .where(and(eq(availabilitySchedules.userId, ctx.user.id), eq(availabilitySchedules.organizationId, ctx.organization.id)));
    await tx.update(availabilitySchedules).set({ isDefault: true, updatedAt: new Date() }).where(eq(availabilitySchedules.id, id));
  });
}

export async function deleteSchedule(ctx: AuthContext, id: string, meta: RequestMeta) {
  const schedule = await loadOwned(ctx, id);
  if (schedule.isDefault) throw new BadRequestError('Make another schedule the default before deleting this one.', 'DEFAULT_SCHEDULE');
  // Event types using it fall back to the default schedule (FK: ON DELETE SET NULL).
  await db.delete(availabilitySchedules).where(eq(availabilitySchedules.id, id));
  await recordAudit({
    organizationId: ctx.organization.id,
    actor: { type: 'user', userId: ctx.user.id },
    action: 'availability.deleted',
    resourceType: 'availability_schedule',
    resourceId: id,
    metadata: { name: schedule.name },
    meta,
  });
}

/** Schedules available for a host (used by the event type editor; admins may pick any member's). */
export async function schedulesForHost(ctx: AuthContext, hostUserIds: string[]) {
  if (!hostUserIds.length) return [];
  return db
    .select({ id: availabilitySchedules.id, userId: availabilitySchedules.userId, name: availabilitySchedules.name, timezone: availabilitySchedules.timezone, isDefault: availabilitySchedules.isDefault })
    .from(availabilitySchedules)
    .where(and(eq(availabilitySchedules.organizationId, ctx.organization.id), inArray(availabilitySchedules.userId, hostUserIds)))
    .orderBy(asc(availabilitySchedules.createdAt));
}
