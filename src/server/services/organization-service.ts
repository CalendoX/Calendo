import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthContext } from '../auth/session';
import { requireAdmin } from '../authz/policy';
import { db } from '../db/client';
import { notificationTemplates, notificationTypes, organizationHolidays, organizationLogos, organizations, users, type NotificationType } from '../db/schema';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors';
import type { RequestMeta } from '../http/request';
import { zTimeZone } from '../http/validation';
import { recordAudit } from './audit';

/** Organisation settings, holidays and email template overrides (admin only). */

export const OrganizationSettingsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #0e7c66'),
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
        before.defaultTimezone !== row.defaultTimezone && 'defaultTimezone',
        JSON.stringify(before.settings) !== JSON.stringify(row.settings) && 'settings',
      ].filter(Boolean),
    },
    meta,
  });
  return row;
}

// Logo -------------------------------------------------------------------------------------

export const MAX_LOGO_BYTES = 1024 * 1024;

/** Identifies the image format from its magic bytes; the client-declared type is not trusted. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const startsWith = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

/** Short content hash carried in the logo URL, so a new upload gets a new (cache-busting) URL. */
export function logoVersion(sha256: string) {
  return sha256.slice(0, 16);
}

export function logoError(message: string) {
  return new ValidationError(message, { file: [message] });
}

/** Stores an uploaded logo and points `organizations.logo_url` at the public route serving it. */
export async function uploadOrganizationLogo(ctx: AuthContext, bytes: Buffer, meta: RequestMeta) {
  requireAdmin(ctx);
  if (bytes.length === 0) throw logoError('Choose an image to upload.');
  if (bytes.length > MAX_LOGO_BYTES) throw logoError('The logo must be 1 MB or smaller.');
  const contentType = sniffImageType(bytes);
  if (!contentType) throw logoError('Upload a PNG, JPG, WebP or GIF image.');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const logoUrl = `/api/public/organizations/${ctx.organization.id}/logo?v=${logoVersion(sha256)}`;
  const now = new Date();
  await db.transaction(async (tx) => {
    const values = { contentType, data: bytes, sha256, updatedById: ctx.user.id, updatedAt: now };
    await tx
      .insert(organizationLogos)
      .values({ organizationId: ctx.organization.id, ...values })
      .onConflictDoUpdate({ target: organizationLogos.organizationId, set: values });
    await tx.update(organizations).set({ logoUrl, updatedAt: now }).where(eq(organizations.id, ctx.organization.id));
  });
  await recordAudit({
    organizationId: ctx.organization.id,
    actor: { type: 'user', userId: ctx.user.id },
    action: 'organization.logo_updated',
    resourceType: 'organization',
    resourceId: ctx.organization.id,
    metadata: { contentType, bytes: bytes.length },
    meta,
  });
  return { logoUrl };
}

export async function removeOrganizationLogo(ctx: AuthContext, meta: RequestMeta) {
  requireAdmin(ctx);
  await db.transaction(async (tx) => {
    await tx.delete(organizationLogos).where(eq(organizationLogos.organizationId, ctx.organization.id));
    await tx.update(organizations).set({ logoUrl: null, updatedAt: new Date() }).where(eq(organizations.id, ctx.organization.id));
  });
  await recordAudit({
    organizationId: ctx.organization.id,
    actor: { type: 'user', userId: ctx.user.id },
    action: 'organization.logo_removed',
    resourceType: 'organization',
    resourceId: ctx.organization.id,
    meta,
  });
}

export async function getOrganizationLogo(organizationId: string) {
  const [row] = await db
    .select({ contentType: organizationLogos.contentType, data: organizationLogos.data, sha256: organizationLogos.sha256 })
    .from(organizationLogos)
    .where(eq(organizationLogos.organizationId, organizationId))
    .limit(1);
  return row ?? null;
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
