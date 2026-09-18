import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthContext } from '../auth/session';
import { requireAdmin } from '../authz/policy';
import { db } from '../db/client';
import { notificationTemplates, notificationTypes, organizationHolidays, organizations, users, type NotificationType } from '../db/schema';
import { ConflictError, NotFoundError } from '../http/errors';
import type { RequestMeta } from '../http/request';
import { zHttpUrl, zTimeZone } from '../http/validation';
import { recordAudit } from './audit';

/** Organisation settings, holidays and email template overrides (admin only). */

export const OrganizationSettingsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #0e7c66'),
  logoUrl: zHttpUrl.refine((v) => v.startsWith('https://'), 'Logo must be served over https').nullish().or(z.literal('').transform(() => null)),
  defaultTimezone: zTimeZone,
  settings: z.object({
    reminderOffsetsMinutes: z.array(z.number().int().min(5).max(60 * 24 * 14)).max(5),
    candidateCanReschedule: z.boolean(),
    candidateCanCancel: z.boolean(),
    candidateManageCutoffMinutes: z.number().int().min(0).max(60 * 24 * 7),
    addCandidateAsCalendarAttendee: z.boolean(),
    bookingPageNotice: z.string().trim().max(1000).optional().default(''),
  }),
});

export async function updateOrganization(ctx: AuthContext, input: z.infer<typeof OrganizationSettingsSchema>, meta: RequestMeta) {
  requireAdmin(ctx);
  const [before] = await db.select().from(organizations).where(eq(organizations.id, ctx.organization.id));
  const offsets = [...new Set(input.settings.reminderOffsetsMinutes)].sort((a, b) => b - a);
  const [row] = await db
    .update(organizations)
    .set({
      name: input.name,
      brandColor: input.brandColor.toLowerCase(),
      logoUrl: input.logoUrl ?? null,
      defaultTimezone: input.defaultTimezone,
      settings: { ...before.settings, ...input.settings, reminderOffsetsMinutes: offsets },
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, ctx.organization.id))
    .returning();
  await recordAudit({
    organizationId: ctx.organization.id,
    actor: { type: 'user', userId: ctx.user.id },
    action: 'organization.settings_updated',
    resourceType: 'organization',
    resourceId: ctx.organization.id,
    metadata: {
      changed: [
        before.name !== row.name && 'name',
        before.brandColor !== row.brandColor && 'brandColor',
        before.logoUrl !== row.logoUrl && 'logoUrl',
        before.defaultTimezone !== row.defaultTimezone && 'defaultTimezone',
        JSON.stringify(before.settings) !== JSON.stringify(row.settings) && 'settings',
      ].filter(Boolean),
    },
    meta,
  });
  return row;
}

export async function listHolidays(ctx: AuthContext) {
  return db
    .select()
    .from(organizationHolidays)
    .where(eq(organizationHolidays.organizationId, ctx.organization.id))
    .orderBy(asc(organizationHolidays.date));
}

export async function addHoliday(ctx: AuthContext, input: { date: string; name: string }, meta: RequestMeta) {
  requireAdmin(ctx);
  const [row] = await db
    .insert(organizationHolidays)
    .values({ organizationId: ctx.organization.id, date: input.date, name: input.name })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new ConflictError('A holiday already exists on this date.', 'DUPLICATE_HOLIDAY');
  await recordAudit({
    organizationId: ctx.organization.id,
    actor: { type: 'user', userId: ctx.user.id },
    action: 'organization.holiday_added',
    resourceType: 'organization',
    resourceId: ctx.organization.id,
    metadata: input,
    meta,
  });
  return row;
}

export async function removeHoliday(ctx: AuthContext, id: string, meta: RequestMeta) {
  requireAdmin(ctx);
  const [row] = await db
    .delete(organizationHolidays)
    .where(and(eq(organizationHolidays.id, id), eq(organizationHolidays.organizationId, ctx.organization.id)))
    .returning();
  if (!row) throw new NotFoundError('Holiday not found');
  await recordAudit({
    organizationId: ctx.organization.id,
    actor: { type: 'user', userId: ctx.user.id },
    action: 'organization.holiday_removed',
    resourceType: 'organization',
    resourceId: ctx.organization.id,
    metadata: { date: row.date, name: row.name },
    meta,
  });
}

export const TemplateInputSchema = z.object({
  subject: z.string().trim().max(200).nullish(),
  intro: z.string().trim().max(2000).nullish(),
  enabled: z.boolean(),
});

export async function listTemplates(ctx: AuthContext) {
  requireAdmin(ctx);
  const rows = await db
    .select({ template: notificationTemplates, updatedBy: users.name })
    .from(notificationTemplates)
    .leftJoin(users, eq(users.id, notificationTemplates.updatedById))
    .where(eq(notificationTemplates.organizationId, ctx.organization.id));
  return notificationTypes.map((type) => {
    const row = rows.find((r) => r.template.type === type);
    return {
      type,
      subject: row?.template.subject ?? null,
      intro: row?.template.intro ?? null,
      enabled: row?.template.enabled ?? true,
      updatedAt: row?.template.updatedAt.toISOString() ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  });
}

export async function upsertTemplate(ctx: AuthContext, type: NotificationType, input: z.infer<typeof TemplateInputSchema>, meta: RequestMeta) {
  requireAdmin(ctx);
  // Cancellation notices to candidates must always go out.
  const enabled = type === 'cancellation' ? true : input.enabled;
  await db
    .insert(notificationTemplates)
    .values({
      organizationId: ctx.organization.id,
      type,
      subject: input.subject || null,
      intro: input.intro || null,
      enabled,
      updatedById: ctx.user.id,
    })
    .onConflictDoUpdate({
      target: [notificationTemplates.organizationId, notificationTemplates.type],
      set: { subject: input.subject || null, intro: input.intro || null, enabled, updatedById: ctx.user.id, updatedAt: new Date() },
    });
  await recordAudit({
    organizationId: ctx.organization.id,
    actor: { type: 'user', userId: ctx.user.id },
    action: 'notification_template.updated',
    resourceType: 'notification_template',
    resourceId: type,
    metadata: { enabled, customSubject: Boolean(input.subject), customIntro: Boolean(input.intro) },
    meta,
  });
}
