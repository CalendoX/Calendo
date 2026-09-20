import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthContext } from '../auth/session';
import { requireAdmin } from '../authz/policy';
import { env } from '../config/env';
import { db } from '../db/client';
import { organizationEmailDomains, type EmailDnsRecord } from '../db/schema';
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from '../http/errors';
import type { RequestMeta } from '../http/request';
import { platformSender } from '../notifications/email-provider';
import { ResendApiError, resendDomains, type ResendDomain } from '../notifications/resend-domains';
import { recordAudit } from './audit';

/**
 * Per-organisation sending domains. Each business connects its own domain (e.g. acme.com): it is
 * registered with Resend, the admin publishes the DNS records Resend reports, and once they verify
 * the organisation's interview emails come from e.g. "Acme Hiring <scheduling@acme.com>".
 * Until then, or if the domain stops verifying, emails fall back to the platform sender.
 */

type Row = typeof organizationEmailDomains.$inferSelect;

const REFRESH_AFTER_MS = 60_000;

const zDomain = z
  .string()
  .trim()
  .toLowerCase()
  // Accept pasted URLs or addresses: "https://acme.com/", "hr@acme.com" → "acme.com".
  .transform((v) => v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^.*@/, '').split(/[/?#:]/)[0].replace(/\.$/, ''))
  .pipe(
    z
      .string()
      .max(253)
      .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Enter a domain you own, like acme.com'),
  );

export const EmailSenderSchema = z.object({
  fromName: z.string().trim().min(1, 'Required').max(80),
  fromLocalPart: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/, 'Use letters, numbers, dots, dashes or underscores'),
});

export const EmailDomainInputSchema = EmailSenderSchema.extend({ domain: zDomain });

export interface EmailDomainView {
  /** Whether this server can manage custom sending domains (Resend with a full-access key). */
  available: boolean;
  /** The platform sender used until a domain is verified. */
  platformFrom: string;
  domain: {
    domain: string;
    status: string;
    verified: boolean;
    records: EmailDnsRecord[];
    fromName: string;
    fromLocalPart: string;
    fromAddress: string;
    verifiedAt: string | null;
    lastCheckedAt: string | null;
  } | null;
}

export function customSendingDomainsAvailable() {
  return env().EMAIL_PROVIDER === 'resend' && Boolean(env().RESEND_API_KEY);
}

function requireAvailable() {
  if (!customSendingDomainsAvailable()) {
    throw new ServiceUnavailableError(
      'Sending from your own domain needs Resend on this server: set EMAIL_PROVIDER=resend and a full-access RESEND_API_KEY.',
      'EMAIL_DOMAINS_UNAVAILABLE',
    );
  }
}

function providerError(err: unknown, field = 'domain'): Error {
  if (!(err instanceof ResendApiError)) return err as Error;
  if (err.status === 0 || err.status >= 500) {
    return new ServiceUnavailableError('The email provider could not be reached. Please try again in a moment.', 'EMAIL_PROVIDER_UNAVAILABLE');
  }
  if (err.status === 409 || /already/i.test(err.message)) {
    return new ConflictError('This domain is already registered with the email provider. Contact support to release it.', 'DOMAIN_ALREADY_REGISTERED');
  }
  if (err.status === 401 || err.status === 403) {
    return new ServiceUnavailableError(
      'The email provider refused the request. The server’s RESEND_API_KEY needs full access (not sending-only) to manage domains.',
      'EMAIL_PROVIDER_FORBIDDEN',
    );
  }
  return new ValidationError(err.message, { [field]: [err.message] });
}

function toRecords(d: ResendDomain, fallback: EmailDnsRecord[] = []): EmailDnsRecord[] {
  if (!d.records) return fallback;
  return d.records.map((r) => ({ type: r.type, name: r.name, value: r.value, priority: r.priority ?? null, status: r.status ?? null }));
}

function view(row: Row | null): EmailDomainView {
  const platform = platformSender();
  return {
    available: customSendingDomainsAvailable(),
    platformFrom: `${platform.name} <${platform.address}>`,
    domain: row && {
      domain: row.domain,
      status: row.status,
      verified: row.status === 'verified',
      records: row.records,
      fromName: row.fromName,
      fromLocalPart: row.fromLocalPart,
      fromAddress: `${row.fromLocalPart}@${row.domain}`,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    },
  };
}

async function load(organizationId: string) {
  const [row] = await db.select().from(organizationEmailDomains).where(eq(organizationEmailDomains.organizationId, organizationId)).limit(1);
  return row ?? null;
}

/** Pulls the latest status and records from Resend; records the moment a domain first verifies. */
async function refresh(ctx: AuthContext, row: Row): Promise<Row> {
  let status: string;
  let records = row.records;
  try {
    const d = await resendDomains.get(row.providerDomainId);
    status = d.status;
    records = toRecords(d, row.records);
  } catch (err) {
    if (err instanceof ResendApiError && err.status === 404) status = 'failed';
    else throw providerError(err);
  }
  const now = new Date();
  const becameVerified = status === 'verified' && row.status !== 'verified';
  const [updated] = await db
    .update(organizationEmailDomains)
    .set({ status, records, lastCheckedAt: now, verifiedAt: becameVerified ? now : row.verifiedAt, updatedAt: now })
    .where(eq(organizationEmailDomains.organizationId, row.organizationId))
    .returning();
  if (becameVerified) {
    await recordAudit({
      organizationId: ctx.organization.id,
      actor: { type: 'system', label: 'Email domain check' },
      action: 'organization.email_domain_verified',
      resourceType: 'organization',
      resourceId: ctx.organization.id,
      metadata: { domain: row.domain },
    });
  }
  return updated;
}

export async function getEmailDomain(ctx: AuthContext): Promise<EmailDomainView> {
  requireAdmin(ctx);
  let row = await load(ctx.organization.id);
  // While waiting on DNS, look again (at most once a minute) whenever an admin opens the page.
  const stale = !row?.lastCheckedAt || Date.now() - row.lastCheckedAt.getTime() > REFRESH_AFTER_MS;
  if (row && row.status !== 'verified' && stale && customSendingDomainsAvailable()) {
    row = await refresh(ctx, row).catch(() => row);
  }
  return view(row);
}

export async function addEmailDomain(ctx: AuthContext, input: z.infer<typeof EmailDomainInputSchema>, meta: RequestMeta): Promise<EmailDomainView> {
  requireAdmin(ctx);
  requireAvailable();
  if (await load(ctx.organization.id)) throw new ConflictError('Remove the current sending domain before adding another.', 'EMAIL_DOMAIN_EXISTS');
  const platformDomain = platformSender().address.split('@')[1]?.toLowerCase();
  if (input.domain === platformDomain) throw new ValidationError('This domain is reserved.', { domain: ['This domain is reserved.'] });
  const [taken] = await db.select({ id: organizationEmailDomains.organizationId }).from(organizationEmailDomains).where(eq(organizationEmailDomains.domain, input.domain)).limit(1);
  if (taken) throw new ConflictError('This domain is already connected to another organization.', 'DOMAIN_TAKEN');

  let created: ResendDomain;
  try {
    created = await resendDomains.create(input.domain);
  } catch (err) {
    throw providerError(err);
  }
  const now = new Date();
  const [row] = await db
    .insert(organizationEmailDomains)
    .values({
      organizationId: ctx.organization.id,
      domain: input.domain,
      providerDomainId: created.id,
      status: created.status ?? 'not_started',
      records: toRecords(created),
      fromName: input.fromName,
      fromLocalPart: input.fromLocalPart,
      lastCheckedAt: now,
    })
    .returning();
  await recordAudit({
    organizationId: ctx.organization.id,
    actor: { type: 'user', userId: ctx.user.id },
    action: 'organization.email_domain_added',
    resourceType: 'organization',
    resourceId: ctx.organization.id,
    metadata: { domain: input.domain },
    meta,
  });
  return view(row);
}

export async function updateEmailSender(ctx: AuthContext, input: z.infer<typeof EmailSenderSchema>, meta: RequestMeta): Promise<EmailDomainView> {
  requireAdmin(ctx);
  const row = await load(ctx.organization.id);
  if (!row) throw new NotFoundError('Add a sending domain first.');
  const [updated] = await db
    .update(organizationEmailDomains)
    .set({ fromName: input.fromName, fromLocalPart: input.fromLocalPart, updatedAt: new Date() })
    .where(eq(organizationEmailDomains.organizationId, ctx.organization.id))
    .returning();
  await recordAudit({
    organizationId: ctx.organization.id,
    actor: { type: 'user', userId: ctx.user.id },
    action: 'organization.email_sender_updated',
    resourceType: 'organization',
    resourceId: ctx.organization.id,
    metadata: { from: `${input.fromName} <${input.fromLocalPart}@${row.domain}>` },
    meta,
  });
  return view(updated);
}

/** Asks Resend to re-check the DNS records now, then returns the fresh status. */
export async function verifyEmailDomain(ctx: AuthContext): Promise<EmailDomainView> {
  requireAdmin(ctx);
  requireAvailable();
  const row = await load(ctx.organization.id);
  if (!row) throw new NotFoundError('Add a sending domain first.');
  try {
    await resendDomains.verify(row.providerDomainId);
  } catch (err) {
    throw providerError(err);
  }
  return view(await refresh(ctx, row));
}

export async function removeEmailDomain(ctx: AuthContext, meta: RequestMeta) {
  requireAdmin(ctx);
  const row = await load(ctx.organization.id);
  if (!row) throw new NotFoundError('No sending domain is connected.');
  if (customSendingDomainsAvailable()) {
    try {
      await resendDomains.remove(row.providerDomainId);
    } catch (err) {
      if (!(err instanceof ResendApiError && err.status === 404)) throw providerError(err);
    }
  }
  await db.delete(organizationEmailDomains).where(eq(organizationEmailDomains.organizationId, ctx.organization.id));
  await recordAudit({
    organizationId: ctx.organization.id,
    actor: { type: 'user', userId: ctx.user.id },
    action: 'organization.email_domain_removed',
    resourceType: 'organization',
    resourceId: ctx.organization.id,
    metadata: { domain: row.domain },
    meta,
  });
}

/** The organisation's own sender, if its domain is verified and this server can send from it. */
export async function organizationSender(organizationId: string): Promise<{ name: string; address: string } | null> {
  if (!customSendingDomainsAvailable()) return null;
  const row = await load(organizationId);
  if (!row || row.status !== 'verified') return null;
  return { name: row.fromName, address: `${row.fromLocalPart}@${row.domain}` };
}

/** The provider refused to send from the domain (DNS records removed?): stop using it until re-verified. */
export async function markSendingDomainRejected(organizationId: string) {
  await db
    .update(organizationEmailDomains)
    .set({ status: 'failed', updatedAt: new Date() })
    .where(eq(organizationEmailDomains.organizationId, organizationId));
}
