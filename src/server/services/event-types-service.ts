import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthContext } from '../auth/session';
import { assertCanAssignHost, assertCanManageEventType, canViewAllInterviews, isAdmin } from '../authz/policy';
import { appUrl } from '../config/env';
import { db } from '../db/client';
import {
  availabilitySchedules,
  eventTypes,
  integrations,
  interviews,
  memberships,
  schedulingLinks,
  users,
  type CustomQuestion,
} from '../db/schema';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors';
import type { RequestMeta } from '../http/request';
import { decrypt, encrypt, hashToken, randomToken } from '../security/crypto';
import { recordAudit } from './audit';
import { slugify } from '@/lib/format';

/** Interview (event) types and their scheduling links. */

const zFieldMode = z.enum(['hidden', 'optional', 'required']);

export const EventTypeInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Required').max(100),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/, 'Use 2–64 lowercase letters, numbers and dashes')
      .optional(),
    description: z.string().trim().max(5000).nullish(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour').optional(),
    durationMinutes: z.number().int().min(5).max(720),
    locationType: z.enum(['zoom', 'google_meet', 'phone', 'in_person', 'custom']),
    locationDetails: z.string().trim().max(500).nullish(),
    hostUserId: z.uuid().optional(),
    scheduleId: z.uuid().nullish(),
    bufferBeforeMinutes: z.number().int().min(0).max(240).default(0),
    bufferAfterMinutes: z.number().int().min(0).max(240).default(0),
    minimumNoticeMinutes: z.number().int().min(0).max(60 * 24 * 90).default(240),
    maxDaysInFuture: z.number().int().min(1).max(730).nullable().default(60),
    slotIntervalMinutes: z.number().int().min(5).max(240).nullable().default(null),
    dailyLimit: z.number().int().min(1).max(50).nullable().default(null),
    isActive: z.boolean().default(true),
    visibility: z.enum(['public', 'link_only']).default('public'),
    questions: z
      .array(
        z.object({
          id: z.string().max(40).optional(),
          label: z.string().trim().min(1, 'Question text is required').max(300),
          type: z.enum(['short_text', 'long_text', 'single_select', 'url']),
          required: z.boolean(),
          options: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
          helpText: z.string().trim().max(300).optional(),
        }),
      )
      .max(10)
      .default([]),
    fieldConfig: z
      .object({ phone: zFieldMode, company: zFieldMode, linkedinUrl: zFieldMode, resumeUrl: zFieldMode })
      .default({ phone: 'optional', company: 'hidden', linkedinUrl: 'optional', resumeUrl: 'optional' }),
    reminderOffsetsMinutes: z.array(z.number().int().min(5).max(60 * 24 * 14)).max(5).nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (['phone', 'in_person', 'custom'].includes(v.locationType) && !v.locationDetails?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['locationDetails'],
        message: v.locationType === 'phone' ? 'Enter the phone number to call' : 'Enter the address or location details',
      });
    }
    v.questions.forEach((q, i) => {
      if (q.type === 'single_select' && (!q.options || q.options.length < 2)) {
        ctx.addIssue({ code: 'custom', path: ['questions', i, 'options'], message: 'Add at least two options' });
      }
    });
  });

export type EventTypeInput = z.infer<typeof EventTypeInputSchema>;
export const EventTypeUpdateSchema = z.object({}).passthrough();

function normaliseQuestions(questions: EventTypeInput['questions']): CustomQuestion[] {
  return questions.map((q) => ({
    id: q.id && /^[a-z0-9_-]+$/i.test(q.id) ? q.id : `q_${randomToken(6).replace(/[^a-z0-9]/gi, '').toLowerCase()}`,
    label: q.label,
    type: q.type,
    required: q.required,
    options: q.type === 'single_select' ? q.options : undefined,
    helpText: q.helpText || undefined,
  }));
}

export function publicUrlFor(username: string, slug: string) {
  return appUrl(`/schedule/${username}/${slug}`);
}

async function uniqueSlug(hostUserId: string, base: string, excludeId?: string) {
  const root = slugify(base) || 'interview';
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const [exists] = await db
      .select({ id: eventTypes.id })
      .from(eventTypes)
      .where(and(eq(eventTypes.hostUserId, hostUserId), eq(eventTypes.slug, candidate), isNull(eventTypes.deletedAt)))
      .limit(1);
    if (!exists || exists.id === excludeId) return candidate;
  }
  return `${root}-${randomToken(3).toLowerCase()}`;
}

async function assertHostInOrg(ctx: AuthContext, hostUserId: string) {
  const [m] = await db
    .select({ status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.userId, hostUserId), eq(memberships.organizationId, ctx.organization.id)))
    .limit(1);
  if (!m || m.status === 'deactivated') throw new ValidationError('Choose an active interviewer from your organization.', { hostUserId: ['Invalid interviewer'] });
}

async function assertScheduleForHost(ctx: AuthContext, scheduleId: string | null | undefined, hostUserId: string) {
  if (!scheduleId) return;
  const [s] = await db
    .select({ userId: availabilitySchedules.userId, organizationId: availabilitySchedules.organizationId })
    .from(availabilitySchedules)
    .where(eq(availabilitySchedules.id, scheduleId))
    .limit(1);
  if (!s || s.organizationId !== ctx.organization.id || s.userId !== hostUserId) {
    throw new ValidationError("Choose one of the interviewer's availability schedules.", { scheduleId: ['Invalid schedule'] });
  }
}

export interface EventTypeListItem {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  color: string;
  durationMinutes: number;
  locationType: (typeof eventTypes.$inferSelect)['locationType'];
  locationDetails: string | null;
  isActive: boolean;
  visibility: 'public' | 'link_only';
  host: { id: string; name: string; username: string };
  publicUrl: string;
  upcomingCount: number;
  totalCount: number;
  zoomReady: boolean;
  updatedAt: string;
}

export async function listEventTypes(ctx: AuthContext, opts: { scope?: 'mine' | 'all'; hostUserId?: string } = {}): Promise<EventTypeListItem[]> {
  const conditions = [eq(eventTypes.organizationId, ctx.organization.id), isNull(eventTypes.deletedAt)];
  const all = opts.scope === 'all' && (isAdmin(ctx) || canViewAllInterviews(ctx));
  if (opts.hostUserId && all) conditions.push(eq(eventTypes.hostUserId, opts.hostUserId));
  else if (!all) conditions.push(eq(eventTypes.hostUserId, ctx.user.id));
  const rows = await db
    .select({ eventType: eventTypes, host: { id: users.id, name: users.name, username: users.username } })
    .from(eventTypes)
    .innerJoin(users, eq(users.id, eventTypes.hostUserId))
    .where(and(...conditions))
    .orderBy(asc(users.name), desc(eventTypes.isActive), asc(eventTypes.name));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.eventType.id);
  const counts = await db
    .select({
      eventTypeId: interviews.eventTypeId,
      total: count(),
      upcoming: sql<number>`count(*) filter (where ${interviews.startAt} > now() and ${interviews.status} in ('scheduled','rescheduled'))`,
    })
    .from(interviews)
    .where(inArray(interviews.eventTypeId, ids))
    .groupBy(interviews.eventTypeId);
  const zoomHosts = new Set(
    (
      await db
        .select({ userId: integrations.userId })
        .from(integrations)
        .where(and(eq(integrations.provider, 'zoom'), eq(integrations.status, 'active'), inArray(integrations.userId, rows.map((r) => r.host.id))))
    ).map((r) => r.userId),
  );
  return rows.map(({ eventType: e, host }) => {
    const c = counts.find((x) => x.eventTypeId === e.id);
    return {
      id: e.id,
      name: e.name,
      slug: e.slug,
      description: e.description,
      color: e.color,
      durationMinutes: e.durationMinutes,
      locationType: e.locationType,
      locationDetails: e.locationDetails,
      isActive: e.isActive,
      visibility: e.visibility,
      host,
      publicUrl: publicUrlFor(host.username, e.slug),
      upcomingCount: Number(c?.upcoming ?? 0),
      totalCount: Number(c?.total ?? 0),
      zoomReady: e.locationType !== 'zoom' || zoomHosts.has(host.id),
      updatedAt: e.updatedAt.toISOString(),
    };
  });
}

export async function getEventType(ctx: AuthContext, id: string) {
  const [row] = await db
    .select({ eventType: eventTypes, host: { id: users.id, name: users.name, username: users.username, timezone: users.timezone } })
    .from(eventTypes)
    .innerJoin(users, eq(users.id, eventTypes.hostUserId))
    .where(and(eq(eventTypes.id, id), isNull(eventTypes.deletedAt)))
    .limit(1);
  if (!row) throw new NotFoundError('Event type not found');
  assertCanManageEventType(ctx, row.eventType);
  return { ...row, publicUrl: publicUrlFor(row.host.username, row.eventType.slug) };
}

export async function createEventType(ctx: AuthContext, input: EventTypeInput, meta: RequestMeta) {
  const hostUserId = input.hostUserId ?? ctx.user.id;
  assertCanAssignHost(ctx, hostUserId);
  await assertHostInOrg(ctx, hostUserId);
  await assertScheduleForHost(ctx, input.scheduleId, hostUserId);
  const slug = input.slug ? input.slug : await uniqueSlug(hostUserId, input.name);
  if (input.slug) {
    const [clash] = await db
      .select({ id: eventTypes.id })
      .from(eventTypes)
      .where(and(eq(eventTypes.hostUserId, hostUserId), eq(eventTypes.slug, slug), isNull(eventTypes.deletedAt)))
      .limit(1);
    if (clash) throw new ValidationError('This URL is already used by another event type.', { slug: ['Already in use'] });
  }
  const [row] = await db
    .insert(eventTypes)
    .values({
      organizationId: ctx.organization.id,
      hostUserId,
      scheduleId: input.scheduleId ?? null,
      slug,
      name: input.name,
      description: input.description ?? null,
      color: input.color ?? ctx.organization.brandColor,
      durationMinutes: input.durationMinutes,
      locationType: input.locationType,
      locationDetails: input.locationType === 'zoom' || input.locationType === 'google_meet' ? null : (input.locationDetails ?? null),
      bufferBeforeMinutes: input.bufferBeforeMinutes,
      bufferAfterMinutes: input.bufferAfterMinutes,
      minimumNoticeMinutes: input.minimumNoticeMinutes,
      maxDaysInFuture: input.maxDaysInFuture,
      slotIntervalMinutes: input.slotIntervalMinutes,
      dailyLimit: input.dailyLimit,
      isActive: input.isActive,
      visibility: input.visibility,
      questions: normaliseQuestions(input.questions),
      fieldConfig: input.fieldConfig,
      reminderOffsetsMinutes: input.reminderOffsetsMinutes,
    })
    .returning();
  await recordAudit({
    organizationId: ctx.organization.id,
    actor: { type: 'user', userId: ctx.user.id },
    action: 'event_type.created',
    resourceType: 'event_type',
    resourceId: row.id,
    metadata: { name: row.name, durationMinutes: row.durationMinutes, hostUserId },
    meta,
  });
  return row;
}

export async function updateEventType(ctx: AuthContext, id: string, input: EventTypeInput, meta: RequestMeta) {
  const { eventType: existing } = await getEventType(ctx, id);
  const hostUserId = input.hostUserId ?? existing.hostUserId;
  if (hostUserId !== existing.hostUserId) {
    assertCanAssignHost(ctx, hostUserId);
    await assertHostInOrg(ctx, hostUserId);
    const [future] = await db
      .select({ n: count() })
      .from(interviews)
      .where(and(eq(interviews.eventTypeId, id), inArray(interviews.status, ['scheduled', 'rescheduled']), sql`${interviews.startAt} > now()`));
    if (Number(future?.n ?? 0) > 0) {
      throw new ConflictError('This event type has upcoming interviews, so its interviewer cannot be changed. Create a new event type instead.', 'HAS_UPCOMING');
    }
  }
  await assertScheduleForHost(ctx, input.scheduleId, hostUserId);
  const slug = input.slug ?? existing.slug;
  if (slug !== existing.slug || hostUserId !== existing.hostUserId) {
    const [clash] = await db
      .select({ id: eventTypes.id })
      .from(eventTypes)
      .where(and(eq(eventTypes.hostUserId, hostUserId), eq(eventTypes.slug, slug), isNull(eventTypes.deletedAt)))
      .limit(1);
    if (clash && clash.id !== id) throw new ValidationError('This URL is already used by another event type.', { slug: ['Already in use'] });
  }
  const changes = {
    hostUserId,
    scheduleId: input.scheduleId ?? null,
    slug,
    name: input.name,
    description: input.description ?? null,
    color: input.color ?? existing.color,
    durationMinutes: input.durationMinutes,
    locationType: input.locationType,
    locationDetails: input.locationType === 'zoom' || input.locationType === 'google_meet' ? null : (input.locationDetails ?? null),
    bufferBeforeMinutes: input.bufferBeforeMinutes,
    bufferAfterMinutes: input.bufferAfterMinutes,
    minimumNoticeMinutes: input.minimumNoticeMinutes,
    maxDaysInFuture: input.maxDaysInFuture,
    slotIntervalMinutes: input.slotIntervalMinutes,
    dailyLimit: input.dailyLimit,
    isActive: input.isActive,
    visibility: input.visibility,
    questions: normaliseQuestions(input.questions),
    fieldConfig: input.fieldConfig,
    reminderOffsetsMinutes: input.reminderOffsetsMinutes,
  };
  const [row] = await db.update(eventTypes).set({ ...changes, updatedAt: new Date() }).where(eq(eventTypes.id, id)).returning();
  const changed = Object.keys(changes).filter(
    (k) => JSON.stringify((existing as Record<string, unknown>)[k]) !== JSON.stringify((row as Record<string, unknown>)[k]),
  );
  await recordAudit({
    organizationId: ctx.organization.id,
    actor: { type: 'user', userId: ctx.user.id },
    action: 'event_type.updated',
    resourceType: 'event_type',
    resourceId: id,
    metadata: { name: row.name, changed },
    meta,
  });
  return row;
}

export async function setEventTypeActive(ctx: AuthContext, id: string, isActive: boolean, meta: RequestMeta) {
  const { eventType } = await getEventType(ctx, id);
  await db.update(eventTypes).set({ isActive, updatedAt: new Date() }).where(eq(eventTypes.id, id));
  await recordAudit({
    organizationId: ctx.organization.id,
    actor: { type: 'user', userId: ctx.user.id },
    action: 'event_type.updated',
    resourceType: 'event_type',
    resourceId: id,
    metadata: { name: eventType.name, changed: ['isActive'], isActive },
    meta,
  });
}

/** Soft delete: the public link stops working; existing interviews keep their history. */
export async function deleteEventType(ctx: AuthContext, id: string, meta: RequestMeta) {
  const { eventType } = await getEventType(ctx, id);
  await db.update(eventTypes).set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() }).where(eq(eventTypes.id, id));
  await db.update(schedulingLinks).set({ revokedAt: new Date() }).where(and(eq(schedulingLinks.eventTypeId, id), isNull(schedulingLinks.revokedAt)));
  await recordAudit({
    organizationId: ctx.organization.id,
    actor: { type: 'user', userId: ctx.user.id },
    action: 'event_type.deleted',
    resourceType: 'event_type',
    resourceId: id,
    metadata: { name: eventType.name },
    meta,
  });
}

// ---------------------------------------------------------------------------------------------
// Scheduling links
// ---------------------------------------------------------------------------------------------

export const SchedulingLinkInputSchema = z.object({
  label: z.string().trim().max(120).nullish(),
  candidateName: z.string().trim().max(120).nullish(),
  candidateEmail: z.string().trim().toLowerCase().max(254).pipe(z.email()).nullish().or(z.literal('').transform(() => null)),
  maxUses: z.number().int().min(1).max(1000).nullable().default(1),
  expiresInDays: z.number().int().min(1).max(365).nullable().default(14),
});

export function schedulingLinkUrl(token: string) {
  return appUrl(`/s/${token}`);
}

export async function listSchedulingLinks(ctx: AuthContext, eventTypeId: string) {
  await getEventType(ctx, eventTypeId);
  const rows = await db
    .select({ link: schedulingLinks, creator: { name: users.name } })
    .from(schedulingLinks)
    .leftJoin(users, eq(users.id, schedulingLinks.createdById))
    .where(eq(schedulingLinks.eventTypeId, eventTypeId))
    .orderBy(desc(schedulingLinks.createdAt))
    .limit(100);
  const now = Date.now();
  return rows.map(({ link, creator }) => {
    const exhausted = link.maxUses !== null && link.useCount >= link.maxUses;
    const expired = Boolean(link.expiresAt && link.expiresAt.getTime() <= now);
    return {
      id: link.id,
      label: link.label,
      candidateName: link.candidateName,
      candidateEmail: link.candidateEmail,
      maxUses: link.maxUses,
      useCount: link.useCount,
      expiresAt: link.expiresAt?.toISOString() ?? null,
      revokedAt: link.revokedAt?.toISOString() ?? null,
      createdAt: link.createdAt.toISOString(),
      createdBy: creator?.name ?? null,
      status: link.revokedAt ? 'revoked' : expired ? 'expired' : exhausted ? 'used' : 'active',
      url: link.revokedAt || expired || exhausted ? null : schedulingLinkUrl(decrypt(link.tokenEncrypted)),
    };
  });
}

export async function createSchedulingLink(
  ctx: AuthContext,
  eventTypeId: string,
  input: z.infer<typeof SchedulingLinkInputSchema>,
  meta: RequestMeta,
) {
  const { eventType } = await getEventType(ctx, eventTypeId);
  const token = randomToken(24);
  const [row] = await db
    .insert(schedulingLinks)
    .values({
      organizationId: ctx.organization.id,
      eventTypeId,
      createdById: ctx.user.id,
      label: input.label || null,
      tokenHash: hashToken(token),
      tokenEncrypted: encrypt(token),
      candidateName: input.candidateName || null,
      candidateEmail: input.candidateEmail || null,
      maxUses: input.maxUses,
      expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000) : null,
    })
    .returning();
  await recordAudit({
    organizationId: ctx.organization.id,
    actor: { type: 'user', userId: ctx.user.id },
    action: 'scheduling_link.created',
    resourceType: 'scheduling_link',
    resourceId: row.id,
    metadata: { eventType: eventType.name, maxUses: row.maxUses, candidateEmail: row.candidateEmail },
    meta,
  });
  return { id: row.id, url: schedulingLinkUrl(token) };
}

export async function revokeSchedulingLink(ctx: AuthContext, linkId: string, meta: RequestMeta) {
  const [link] = await db.select().from(schedulingLinks).where(eq(schedulingLinks.id, linkId)).limit(1);
  if (!link || link.organizationId !== ctx.organization.id) throw new NotFoundError('Link not found');
  await getEventType(ctx, link.eventTypeId); // authorisation
  await db.update(schedulingLinks).set({ revokedAt: new Date() }).where(eq(schedulingLinks.id, linkId));
  await recordAudit({
    organizationId: ctx.organization.id,
    actor: { type: 'user', userId: ctx.user.id },
    action: 'scheduling_link.revoked',
    resourceType: 'scheduling_link',
    resourceId: linkId,
    meta,
  });
}

/** Members an event type can be assigned to (admins: everyone active; others: themselves). */
export async function assignableHosts(ctx: AuthContext) {
  if (!isAdmin(ctx)) return [{ id: ctx.user.id, name: ctx.user.name }];
  return db
    .select({ id: users.id, name: users.name })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organizationId, ctx.organization.id), inArray(memberships.status, ['active', 'invited'])))
    .orderBy(users.name);
}
