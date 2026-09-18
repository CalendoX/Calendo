import { DateTime } from 'luxon';
import { and, asc, count, desc, eq, gt, gte, ilike, inArray, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/session';
import { assertCanViewInterview, canViewAllInterviews, isAdmin, requireAdmin } from '../authz/policy';
import { db } from '../db/client';
import {
  auditLogs,
  calendarEvents,
  candidates,
  eventTypes,
  integrations,
  interviewReschedules,
  interviews,
  memberships,
  notifications,
  users,
  videoMeetings,
  webhookEvents,
  type InterviewStatus,
  type SyncStatus,
} from '../db/schema';
import { NotFoundError } from '../http/errors';

/** Read models for interviews: lists, details, calendar, dashboards and the audit log. */

export type InterviewView = 'upcoming' | 'today' | 'week' | 'past' | 'cancelled' | 'rescheduled' | 'all';

export interface InterviewFilters {
  view?: InterviewView;
  q?: string;
  interviewerId?: string;
  eventTypeId?: string;
  status?: InterviewStatus;
  from?: string; // YYYY-MM-DD (viewer zone)
  to?: string;
  sort?: 'start_asc' | 'start_desc' | 'created_desc';
  page?: number;
  pageSize?: number;
  scope?: 'mine' | 'team';
}

export interface InterviewListItem {
  id: string;
  title: string;
  status: InterviewStatus;
  startAt: string;
  endAt: string;
  timezone: string;
  candidateTimezone: string;
  candidate: { id: string; name: string; email: string };
  eventType: { id: string; name: string; color: string };
  host: { id: string; name: string };
  locationType: (typeof interviews.$inferSelect)['locationType'];
  meetingStatus: SyncStatus | null;
  calendarStatus: SyncStatus | null;
  rescheduleCount: number;
  createdAt: string;
}

const hostUser = alias(users, 'host_user');

function scopeCondition(ctx: AuthContext, scope: 'mine' | 'team' | undefined): SQL {
  const orgCond = eq(interviews.organizationId, ctx.organization.id);
  if (scope === 'team' && canViewAllInterviews(ctx)) return orgCond;
  if (!canViewAllInterviews(ctx) || scope === 'mine') return and(orgCond, eq(interviews.hostUserId, ctx.user.id))!;
  return orgCond;
}

function zoneRange(zone: string, unit: 'day' | 'week', base = DateTime.now()) {
  const local = base.setZone(zone);
  const start = local.startOf(unit);
  return { start: start.toJSDate(), end: start.plus({ [unit === 'day' ? 'days' : 'weeks']: 1 }).toJSDate() };
}

const ACTIVE: InterviewStatus[] = ['scheduled', 'rescheduled'];

function listSelect() {
  return {
    interview: interviews,
    candidate: { id: candidates.id, name: candidates.name, email: candidates.email },
    eventType: { id: eventTypes.id, name: eventTypes.name, color: eventTypes.color },
    host: { id: hostUser.id, name: hostUser.name },
    meetingStatus: videoMeetings.status,
    calendarStatus: calendarEvents.status,
  };
}

function baseListQuery() {
  return db
    .select(listSelect())
    .from(interviews)
    .innerJoin(candidates, eq(candidates.id, interviews.candidateId))
    .innerJoin(eventTypes, eq(eventTypes.id, interviews.eventTypeId))
    .innerJoin(hostUser, eq(hostUser.id, interviews.hostUserId))
    .leftJoin(videoMeetings, eq(videoMeetings.interviewId, interviews.id))
    .leftJoin(calendarEvents, eq(calendarEvents.interviewId, interviews.id));
}

type ListRow = Awaited<ReturnType<ReturnType<typeof baseListQuery>['execute']>>[number];

function toListItem(r: ListRow): InterviewListItem {
  return {
    id: r.interview.id,
    title: r.interview.title,
    status: r.interview.status,
    startAt: r.interview.startAt.toISOString(),
    endAt: r.interview.endAt.toISOString(),
    timezone: r.interview.timezone,
    candidateTimezone: r.interview.candidateTimezone,
    candidate: r.candidate,
    eventType: r.eventType,
    host: r.host,
    locationType: r.interview.locationType,
    meetingStatus: r.meetingStatus,
    calendarStatus: r.calendarStatus,
    rescheduleCount: r.interview.rescheduleCount,
    createdAt: r.interview.createdAt.toISOString(),
  };
}

export async function listInterviews(ctx: AuthContext, f: InterviewFilters) {
  const zone = ctx.user.timezone;
  const now = new Date();
  const conditions: SQL[] = [scopeCondition(ctx, f.scope ?? 'team')];
  let order: SQL[] = [asc(interviews.startAt)];

  switch (f.view ?? 'upcoming') {
    case 'upcoming':
      conditions.push(inArray(interviews.status, ACTIVE), gt(interviews.endAt, now));
      break;
    case 'today': {
      const r = zoneRange(zone, 'day');
      conditions.push(gte(interviews.startAt, r.start), lt(interviews.startAt, r.end), ne(interviews.status, 'cancelled'));
      break;
    }
    case 'week': {
      const r = zoneRange(zone, 'week');
      conditions.push(gte(interviews.startAt, r.start), lt(interviews.startAt, r.end), ne(interviews.status, 'cancelled'));
      break;
    }
    case 'past':
      conditions.push(ne(interviews.status, 'cancelled'), or(lte(interviews.endAt, now), inArray(interviews.status, ['completed', 'no_show']))!);
      order = [desc(interviews.startAt)];
      break;
    case 'cancelled':
      conditions.push(eq(interviews.status, 'cancelled'));
      order = [desc(interviews.startAt)];
      break;
    case 'rescheduled':
      conditions.push(gt(interviews.rescheduleCount, 0));
      order = [desc(interviews.startAt)];
      break;
    case 'all':
      order = [desc(interviews.startAt)];
      break;
  }
  if (f.q) {
    const q = `%${f.q.trim().replace(/[%_\\]/g, '\\$&')}%`;
    conditions.push(or(ilike(candidates.name, q), ilike(candidates.email, q), ilike(hostUser.name, q), ilike(eventTypes.name, q))!);
  }
  if (f.interviewerId) conditions.push(eq(interviews.hostUserId, f.interviewerId));
  if (f.eventTypeId) conditions.push(eq(interviews.eventTypeId, f.eventTypeId));
  if (f.status) conditions.push(eq(interviews.status, f.status));
  if (f.from) {
    const d = DateTime.fromISO(f.from, { zone });
    if (d.isValid) conditions.push(gte(interviews.startAt, d.startOf('day').toJSDate()));
  }
  if (f.to) {
    const d = DateTime.fromISO(f.to, { zone });
    if (d.isValid) conditions.push(lt(interviews.startAt, d.endOf('day').toJSDate()));
  }
  if (f.sort === 'start_asc') order = [asc(interviews.startAt)];
  if (f.sort === 'start_desc') order = [desc(interviews.startAt)];
  if (f.sort === 'created_desc') order = [desc(interviews.createdAt)];

  const pageSize = Math.min(Math.max(f.pageSize ?? 25, 1), 100);
  const page = Math.max(f.page ?? 1, 1);
  const where = and(...conditions);
  const [rows, [{ total }]] = await Promise.all([
    baseListQuery()
      .where(where)
      .orderBy(...order, asc(interviews.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ total: count() })
      .from(interviews)
      .innerJoin(candidates, eq(candidates.id, interviews.candidateId))
      .innerJoin(eventTypes, eq(eventTypes.id, interviews.eventTypeId))
      .innerJoin(hostUser, eq(hostUser.id, interviews.hostUserId))
      .where(where),
  ]);
  return { items: rows.map(toListItem), total: Number(total), page, pageSize };
}

export async function listInterviewsInRange(
  ctx: AuthContext,
  opts: { start: Date; end: Date; scope?: 'mine' | 'team'; interviewerId?: string; includeCancelled?: boolean },
) {
  const conditions: SQL[] = [scopeCondition(ctx, opts.scope ?? 'mine'), lt(interviews.startAt, opts.end), gt(interviews.endAt, opts.start)];
  if (!opts.includeCancelled) conditions.push(ne(interviews.status, 'cancelled'));
  if (opts.interviewerId) conditions.push(eq(interviews.hostUserId, opts.interviewerId));
  const rows = await baseListQuery()
    .where(and(...conditions))
    .orderBy(asc(interviews.startAt))
    .limit(1000);
  return rows.map(toListItem);
}

export async function getInterviewDetails(ctx: AuthContext, id: string) {
  const [row] = await db
    .select({ interview: interviews, candidate: candidates, eventType: eventTypes, host: hostUser })
    .from(interviews)
    .innerJoin(candidates, eq(candidates.id, interviews.candidateId))
    .innerJoin(eventTypes, eq(eventTypes.id, interviews.eventTypeId))
    .innerJoin(hostUser, eq(hostUser.id, interviews.hostUserId))
    .where(eq(interviews.id, id))
    .limit(1);
  if (!row) throw new NotFoundError('Interview not found');
  assertCanViewInterview(ctx, row.interview);

  const actor = alias(users, 'actor');
  const [meeting, calendarEvent, reschedules, timeline, notes, previousInterviews] = await Promise.all([
    db.select().from(videoMeetings).where(eq(videoMeetings.interviewId, id)).limit(1),
    db.select().from(calendarEvents).where(eq(calendarEvents.interviewId, id)).limit(1),
    db
      .select({ r: interviewReschedules, actorName: actor.name })
      .from(interviewReschedules)
      .leftJoin(actor, eq(actor.id, interviewReschedules.actorUserId))
      .where(eq(interviewReschedules.interviewId, id))
      .orderBy(desc(interviewReschedules.createdAt)),
    db
      .select({ log: auditLogs, actorName: actor.name })
      .from(auditLogs)
      .leftJoin(actor, eq(actor.id, auditLogs.actorUserId))
      .where(and(eq(auditLogs.resourceType, 'interview'), eq(auditLogs.resourceId, id), eq(auditLogs.organizationId, ctx.organization.id)))
      .orderBy(desc(auditLogs.createdAt))
      .limit(50),
    db
      .select({
        id: notifications.id,
        type: notifications.type,
        recipientType: notifications.recipientType,
        recipientEmail: notifications.recipientEmail,
        status: notifications.status,
        scheduledFor: notifications.scheduledFor,
        sentAt: notifications.sentAt,
        lastError: notifications.lastError,
      })
      .from(notifications)
      .where(eq(notifications.interviewId, id))
      .orderBy(asc(notifications.scheduledFor)),
    db
      .select({ id: interviews.id, startAt: interviews.startAt, status: interviews.status, eventTypeName: eventTypes.name })
      .from(interviews)
      .innerJoin(eventTypes, eq(eventTypes.id, interviews.eventTypeId))
      .where(and(eq(interviews.candidateId, row.candidate.id), ne(interviews.id, id)))
      .orderBy(desc(interviews.startAt))
      .limit(10),
  ]);
  const m = meeting[0];
  const c = calendarEvent[0];
  const now = Date.now();
  const active = row.interview.status === 'scheduled' || row.interview.status === 'rescheduled';
  return {
    interview: {
      id: row.interview.id,
      title: row.interview.title,
      status: row.interview.status,
      startAt: row.interview.startAt.toISOString(),
      endAt: row.interview.endAt.toISOString(),
      timezone: row.interview.timezone,
      candidateTimezone: row.interview.candidateTimezone,
      locationType: row.interview.locationType,
      locationDetails: row.interview.locationDetails,
      responses: row.interview.responses,
      source: row.interview.source,
      version: row.interview.version,
      rescheduleCount: row.interview.rescheduleCount,
      bufferBeforeMinutes: row.interview.bufferBeforeMinutes,
      bufferAfterMinutes: row.interview.bufferAfterMinutes,
      cancelReason: row.interview.cancelReason,
      cancelledAt: row.interview.cancelledAt?.toISOString() ?? null,
      cancelledByType: row.interview.cancelledByType,
      createdAt: row.interview.createdAt.toISOString(),
    },
    candidate: {
      id: row.candidate.id,
      name: row.candidate.name,
      email: row.candidate.email,
      phone: row.candidate.phone,
      company: row.candidate.company,
      linkedinUrl: row.candidate.linkedinUrl,
      resumeUrl: row.candidate.resumeUrl,
      timezone: row.candidate.timezone,
    },
    eventType: { id: row.eventType.id, name: row.eventType.name, color: row.eventType.color, durationMinutes: row.eventType.durationMinutes, slug: row.eventType.slug },
    host: { id: row.host.id, name: row.host.name, email: row.host.email, timezone: row.host.timezone, username: row.host.username },
    meeting: m
      ? {
          provider: m.provider,
          status: m.status,
          joinUrl: m.joinUrl,
          passcode: m.passcode,
          externalMeetingId: m.externalMeetingId,
          hasHostUrl: Boolean(m.hostUrlEncrypted),
          lastError: m.lastError,
          attempts: m.attempts,
          syncedAt: m.syncedAt?.toISOString() ?? null,
          lastAttemptAt: m.lastAttemptAt?.toISOString() ?? null,
        }
      : null,
    calendarEvent: c
      ? {
          provider: c.provider,
          status: c.status,
          htmlLink: c.htmlLink,
          externalCalendarId: c.externalCalendarId,
          lastError: c.lastError,
          attempts: c.attempts,
          syncedAt: c.syncedAt?.toISOString() ?? null,
          lastAttemptAt: c.lastAttemptAt?.toISOString() ?? null,
        }
      : null,
    reschedules: reschedules.map(({ r, actorName }) => ({
      id: r.id,
      previousStartAt: r.previousStartAt.toISOString(),
      previousEndAt: r.previousEndAt.toISOString(),
      newStartAt: r.newStartAt.toISOString(),
      newEndAt: r.newEndAt.toISOString(),
      actorType: r.actorType,
      actorName: actorName ?? (r.actorType === 'candidate' ? row.candidate.name : 'System'),
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
    })),
    timeline: timeline.map(({ log, actorName }) => ({
      id: log.id,
      action: log.action,
      actorType: log.actorType,
      actorName: actorName ?? log.actorLabel ?? (log.actorType === 'candidate' ? row.candidate.name : 'System'),
      metadata: log.metadata,
      createdAt: log.createdAt.toISOString(),
    })),
    notifications: notes.map((n) => ({
      ...n,
      scheduledFor: n.scheduledFor.toISOString(),
      sentAt: n.sentAt?.toISOString() ?? null,
    })),
    otherInterviews: previousInterviews.map((p) => ({ ...p, startAt: p.startAt.toISOString() })),
    permissions: {
      canReschedule: active && row.interview.endAt.getTime() > now,
      canCancel: active && row.interview.endAt.getTime() > now,
      canMarkOutcome: row.interview.status !== 'cancelled' && row.interview.startAt.getTime() <= now,
      canRetrySync: Boolean(m || c),
      canStartMeeting: ctx.user.id === row.host.id && Boolean(m?.externalMeetingId) && m?.status === 'synced',
    },
  };
}

export type InterviewDetails = Awaited<ReturnType<typeof getInterviewDetails>>;

export async function getDashboard(ctx: AuthContext, scope: 'mine' | 'team') {
  const zone = ctx.user.timezone;
  const scopeCond = scopeCondition(ctx, scope);
  const today = zoneRange(zone, 'day');
  const week = zoneRange(zone, 'week');
  const now = new Date();
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [stats] = await db
    .select({
      today: sql<number>`count(*) filter (where ${interviews.startAt} >= ${today.start.toISOString()} and ${interviews.startAt} < ${today.end.toISOString()} and ${interviews.status} <> 'cancelled')`,
      upcoming: sql<number>`count(*) filter (where ${interviews.startAt} > ${now.toISOString()} and ${interviews.status} in ('scheduled','rescheduled'))`,
      thisWeek: sql<number>`count(*) filter (where ${interviews.startAt} >= ${week.start.toISOString()} and ${interviews.startAt} < ${week.end.toISOString()} and ${interviews.status} <> 'cancelled')`,
      total: sql<number>`count(*) filter (where ${interviews.status} <> 'cancelled')`,
      cancelled30d: sql<number>`count(*) filter (where ${interviews.status} = 'cancelled' and ${interviews.cancelledAt} >= ${monthAgo.toISOString()})`,
      rescheduled: sql<number>`count(*) filter (where ${interviews.rescheduleCount} > 0 and ${interviews.status} <> 'cancelled')`,
      noShows: sql<number>`count(*) filter (where ${interviews.status} = 'no_show')`,
    })
    .from(interviews)
    .where(scopeCond);

  const upcoming = await baseListQuery()
    .where(and(scopeCond, inArray(interviews.status, ACTIVE), gt(interviews.endAt, now)))
    .orderBy(asc(interviews.startAt))
    .limit(8);

  const failing = await baseListQuery()
    .where(
      and(
        scopeCond,
        inArray(interviews.status, [...ACTIVE, 'cancelled']),
        gt(interviews.endAt, now),
        or(inArray(videoMeetings.status, ['failed', 'deleted_externally']), inArray(calendarEvents.status, ['failed', 'deleted_externally'])),
      ),
    )
    .orderBy(asc(interviews.startAt))
    .limit(10);

  const myIntegrations = await db
    .select({ provider: integrations.provider, status: integrations.status, accountEmail: integrations.externalAccountEmail, lastError: integrations.lastError })
    .from(integrations)
    .where(eq(integrations.userId, ctx.user.id));

  return {
    stats: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, Number(v)])) as Record<keyof typeof stats, number>,
    upcoming: upcoming.map(toListItem),
    next: upcoming[0] ? toListItem(upcoming[0]) : null,
    needsAttention: failing.map(toListItem),
    integrations: myIntegrations,
  };
}

export async function getAdminOverview(ctx: AuthContext) {
  requireAdmin(ctx);
  const org = ctx.organization.id;
  const zone = ctx.user.timezone;
  const today = zoneRange(zone, 'day');
  const now = new Date();
  const [userStats] = await db
    .select({
      total: count(),
      active: sql<number>`count(*) filter (where ${memberships.status} = 'active')`,
      invited: sql<number>`count(*) filter (where ${memberships.status} = 'invited')`,
      deactivated: sql<number>`count(*) filter (where ${memberships.status} = 'deactivated')`,
      activeLast30: sql<number>`count(*) filter (where ${memberships.status} = 'active' and ${users.lastLoginAt} > now() - interval '30 days')`,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.organizationId, org));
  const [interviewStats] = await db
    .select({
      total: count(),
      upcoming: sql<number>`count(*) filter (where ${interviews.startAt} > ${now.toISOString()} and ${interviews.status} in ('scheduled','rescheduled'))`,
      today: sql<number>`count(*) filter (where ${interviews.startAt} >= ${today.start.toISOString()} and ${interviews.startAt} < ${today.end.toISOString()} and ${interviews.status} <> 'cancelled')`,
      cancelled: sql<number>`count(*) filter (where ${interviews.status} = 'cancelled')`,
      completed: sql<number>`count(*) filter (where ${interviews.status} = 'completed')`,
      noShow: sql<number>`count(*) filter (where ${interviews.status} = 'no_show')`,
      rescheduled: sql<number>`count(*) filter (where ${interviews.rescheduleCount} > 0)`,
    })
    .from(interviews)
    .where(eq(interviews.organizationId, org));
  const integrationStats = await db
    .select({ provider: integrations.provider, status: integrations.status, n: count() })
    .from(integrations)
    .where(eq(integrations.organizationId, org))
    .groupBy(integrations.provider, integrations.status);
  const [syncFailures] = await db
    .select({
      meetings: sql<number>`(select count(*) from ${videoMeetings} vm join ${interviews} i on i.id = vm.interview_id where i.organization_id = ${org} and vm.status = 'failed' and i.end_at > now())`,
      calendar: sql<number>`(select count(*) from ${calendarEvents} ce join ${interviews} i on i.id = ce.interview_id where i.organization_id = ${org} and ce.status = 'failed' and i.end_at > now())`,
      emails: sql<number>`(select count(*) from ${notifications} n where n.organization_id = ${org} and n.status = 'failed')`,
    })
    .from(sql`(select 1) as one`);

  // Daily volume: 14 days back and 14 days ahead in the admin's zone.
  const startDay = DateTime.now().setZone(zone).startOf('day').minus({ days: 13 });
  const endDay = DateTime.now().setZone(zone).startOf('day').plus({ days: 15 });
  const volumeRows = await db
    .select({
      day: sql<string>`to_char(${interviews.startAt} at time zone ${zone}, 'YYYY-MM-DD')`,
      scheduled: sql<number>`count(*) filter (where ${interviews.status} <> 'cancelled')`,
      cancelled: sql<number>`count(*) filter (where ${interviews.status} = 'cancelled')`,
    })
    .from(interviews)
    .where(and(eq(interviews.organizationId, org), gte(interviews.startAt, startDay.toJSDate()), lt(interviews.startAt, endDay.toJSDate())))
    .groupBy(sql`1`);
  const volume: { date: string; scheduled: number; cancelled: number }[] = [];
  for (let d = startDay; d < endDay; d = d.plus({ days: 1 })) {
    const key = d.toISODate()!;
    const r = volumeRows.find((v) => v.day === key);
    volume.push({ date: key, scheduled: Number(r?.scheduled ?? 0), cancelled: Number(r?.cancelled ?? 0) });
  }

  const load = await db
    .select({
      hostUserId: interviews.hostUserId,
      name: users.name,
      upcoming: sql<number>`count(*) filter (where ${interviews.startAt} > now() and ${interviews.status} in ('scheduled','rescheduled'))`,
      last30: sql<number>`count(*) filter (where ${interviews.startAt} > now() - interval '30 days' and ${interviews.startAt} <= now() and ${interviews.status} <> 'cancelled')`,
    })
    .from(interviews)
    .innerJoin(users, eq(users.id, interviews.hostUserId))
    .where(eq(interviews.organizationId, org))
    .groupBy(interviews.hostUserId, users.name)
    .orderBy(desc(sql`3`))
    .limit(8);

  const recent = await listAuditLogs(ctx, { pageSize: 12 });
  const num = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v)]));
  return {
    users: num(userStats),
    interviews: num(interviewStats),
    integrations: integrationStats.map((i) => ({ ...i, n: Number(i.n) })),
    syncFailures: num(syncFailures),
    volume,
    load: load.map((l) => ({ ...l, upcoming: Number(l.upcoming), last30: Number(l.last30) })),
    recentActivity: recent.items,
  };
}

export async function listAuditLogs(
  ctx: AuthContext,
  f: { q?: string; action?: string; actorId?: string; resourceType?: string; page?: number; pageSize?: number },
) {
  if (!isAdmin(ctx)) requireAdmin(ctx);
  const actor = alias(users, 'audit_actor');
  const conditions: SQL[] = [eq(auditLogs.organizationId, ctx.organization.id)];
  if (f.action) conditions.push(ilike(auditLogs.action, `${f.action.replace(/[%_\\]/g, '\\$&')}%`));
  if (f.actorId) conditions.push(eq(auditLogs.actorUserId, f.actorId));
  if (f.resourceType) conditions.push(eq(auditLogs.resourceType, f.resourceType));
  if (f.q) {
    const q = `%${f.q.replace(/[%_\\]/g, '\\$&')}%`;
    conditions.push(or(ilike(actor.name, q), ilike(auditLogs.actorLabel, q), sql`${auditLogs.metadata}::text ilike ${q}`, ilike(auditLogs.resourceId, q))!);
  }
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 200);
  const page = Math.max(f.page ?? 1, 1);
  const where = and(...conditions);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ log: auditLogs, actorName: actor.name, actorEmail: actor.email })
      .from(auditLogs)
      .leftJoin(actor, eq(actor.id, auditLogs.actorUserId))
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: count() }).from(auditLogs).leftJoin(actor, eq(actor.id, auditLogs.actorUserId)).where(where),
  ]);
  return {
    items: rows.map(({ log, actorName, actorEmail }) => ({
      id: log.id,
      action: log.action,
      actorType: log.actorType,
      actorName: actorName ?? log.actorLabel ?? (log.actorType === 'system' ? 'System' : log.actorType),
      actorEmail,
      resourceType: log.resourceType,
      resourceId: log.resourceId,
      metadata: log.metadata,
      ipAddress: log.ipAddress,
      createdAt: log.createdAt.toISOString(),
    })),
    total: Number(total),
    page,
    pageSize,
  };
}

/** System health for the admin "System settings" page (no secrets). */
export async function getWebhookStats() {
  const rows = await db
    .select({ provider: webhookEvents.provider, status: webhookEvents.status, n: count() })
    .from(webhookEvents)
    .where(gt(webhookEvents.receivedAt, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)))
    .groupBy(webhookEvents.provider, webhookEvents.status);
  return rows.map((r) => ({ ...r, n: Number(r.n) }));
}

/** Interviewers visible in filters. */
export async function listInterviewers(ctx: AuthContext) {
  if (!canViewAllInterviews(ctx)) return [{ id: ctx.user.id, name: ctx.user.name }];
  return db
    .select({ id: users.id, name: users.name })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.organizationId, ctx.organization.id))
    .orderBy(users.name);
}

export async function listEventTypeOptions(ctx: AuthContext) {
  const conditions = [eq(eventTypes.organizationId, ctx.organization.id)];
  if (!canViewAllInterviews(ctx)) conditions.push(eq(eventTypes.hostUserId, ctx.user.id));
  return db
    .select({ id: eventTypes.id, name: eventTypes.name, hostName: users.name })
    .from(eventTypes)
    .innerJoin(users, eq(users.id, eventTypes.hostUserId))
    .where(and(...conditions))
    .orderBy(eventTypes.name);
}
