import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DELETE as removeRoute, GET as viewRoute, PATCH as senderRoute, POST as addRoute } from '@/app/api/admin/email-domain/route';
import { POST as verifyRoute } from '@/app/api/admin/email-domain/verify/route';
import { POST as bookRoute } from '@/app/api/public/book/[username]/[eventSlug]/route';
import { resetEnvCache } from '@/server/config/env';
import { db } from '@/server/db/client';
import { auditLogs, organizationEmailDomains } from '@/server/db/schema';
import { deliverDueNotifications } from '../helpers/db';
import { fakeProviders } from '../helpers/fake-providers';
import { createEventType, createMember, createOrg, signIn, signOut, upcomingWeekday, type Org } from '../helpers/fixtures';
import { call } from '../helpers/http';
import { outbox } from '../helpers/outbox';

const TZ = 'America/New_York';
const resend = () => fakeProviders.resend;

function useResend(on: boolean) {
  if (on) {
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_test_key';
  } else {
    process.env.EMAIL_PROVIDER = 'console';
    delete process.env.RESEND_API_KEY;
  }
  resetEnvCache();
}

beforeEach(() => useResend(true));
afterEach(() => useResend(false));

async function world(name = 'Acme') {
  const org = await createOrg({ name });
  const admin = await createMember(org, { role: 'admin' });
  const host = await createMember(org, { role: 'interviewer', name: 'Priya Nair', timezone: TZ });
  const eventType = await createEventType(org, host, { name: 'Technical Interview' });
  return { org, admin, host, eventType };
}

const addDomain = (body: Record<string, unknown>) => call(addRoute, { path: '/api/admin/email-domain', body });
const verify = () => call(verifyRoute, { path: '/api/admin/email-domain/verify', body: {} });

/** Books an interview as a candidate and returns the confirmation email they received. */
async function confirmationFor(w: Awaited<ReturnType<typeof world>>, hour = '10:00') {
  const email = `c-${randomUUID().slice(0, 6)}@candidate.test`;
  const res = await call(bookRoute, {
    path: '/x',
    params: { username: w.host.username, eventSlug: w.eventType.slug },
    body: { start: upcomingWeekday(TZ, hour).toISOString(), name: 'Riley Carter', email, timezone: 'Europe/London', answers: {} },
    origin: false,
  });
  expect(res.status).toBe(201);
  await deliverDueNotifications();
  const [message] = outbox.to(email);
  return message;
}

async function row(org: Org) {
  const [r] = await db.select().from(organizationEmailDomains).where(eq(organizationEmailDomains.organizationId, org.id));
  return r ?? null;
}

describe('organisation sending domains', () => {
  it('connects a domain: registers it with Resend and returns the DNS records to publish', async () => {
    const w = await world();
    await signIn(w.admin, w.org);
    // Pasted URLs are reduced to the domain; the sender address is normalised.
    const res = await addDomain({ domain: 'https://Acme.test/', fromName: 'Acme Hiring', fromLocalPart: 'Talent' });
    expect(res.status).toBe(201);
    expect(res.body.domain).toMatchObject({ domain: 'acme.test', verified: false, fromName: 'Acme Hiring', fromAddress: 'talent@acme.test' });
    expect(res.body.domain.records.map((r: { type: string; name: string }) => `${r.type} ${r.name}`)).toEqual(['MX send', 'TXT send', 'TXT resend._domainkey']);
    expect([...resend().domains.values()].map((d) => d.name)).toEqual(['acme.test']);
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, 'organization.email_domain_added'));
    expect(audit).toMatchObject({ organizationId: w.org.id, metadata: { domain: 'acme.test' } });
    signOut();
  });

  it('sends interview emails from the business domain once its DNS records verify', async () => {
    const w = await world();
    await signIn(w.admin, w.org);
    await addDomain({ domain: 'acme.test', fromName: 'Acme Hiring', fromLocalPart: 'talent' });

    // Not verified yet: the platform sender, named for the business.
    const before = await confirmationFor(w, '10:00');
    expect(before.from).toBeUndefined();
    expect(before.fromName).toBe('Acme (via Calendo)');

    const pending = await verify();
    expect(pending.body.domain).toMatchObject({ verified: false, status: 'pending' });

    resend().publishDns('acme.test');
    await signIn(w.admin, w.org);
    const verified = await verify();
    expect(verified.status).toBe(200);
    expect(verified.body.domain).toMatchObject({ verified: true, status: 'verified' });
    expect((await row(w.org))!.verifiedAt).not.toBeNull();

    const after = await confirmationFor(w, '14:00');
    expect(after.from).toEqual({ name: 'Acme Hiring', address: 'talent@acme.test' });
    expect(after.fromName).toBe('Acme Hiring');
    signOut();
  });

  it('falls back to the platform sender, and flags the domain, if the provider stops accepting it', async () => {
    const w = await world();
    await signIn(w.admin, w.org);
    await addDomain({ domain: 'acme.test', fromName: 'Acme Hiring', fromLocalPart: 'talent' });
    resend().publishDns('acme.test');
    await verify();
    signOut();

    outbox.rejectCustomSenders = true;
    const message = await confirmationFor(w);
    expect(message.from).toBeUndefined();
    expect(message.fromName).toBe('Acme (via Calendo)');
    expect((await row(w.org))!.status).toBe('failed');
  });

  it('lets admins change the sender and remove the domain, which also deletes it from Resend', async () => {
    const w = await world();
    await signIn(w.admin, w.org);
    await addDomain({ domain: 'acme.test', fromName: 'Acme Hiring', fromLocalPart: 'talent' });

    const changed = await call(senderRoute, { method: 'PATCH', path: '/x', body: { fromName: 'Acme Careers', fromLocalPart: 'careers' } });
    expect(changed.body.domain).toMatchObject({ fromName: 'Acme Careers', fromAddress: 'careers@acme.test' });

    expect((await call(removeRoute, { method: 'DELETE', path: '/x' })).status).toBe(200);
    expect(await row(w.org)).toBeNull();
    expect(resend().domains.size).toBe(0);
    expect((await call(viewRoute, { path: '/x' })).body).toMatchObject({ available: true, domain: null });
    signOut();
  });

  it('is admin-only, gives each domain to one organisation, and reserves the platform domain', async () => {
    const a = await world('Acme');
    const b = await world('Globex');

    await signIn(a.host, a.org);
    expect((await addDomain({ domain: 'acme.test', fromName: 'X', fromLocalPart: 'x' })).status).toBe(403);

    await signIn(a.admin, a.org);
    expect((await addDomain({ domain: 'acme.test', fromName: 'Acme', fromLocalPart: 'talent' })).status).toBe(201);
    expect((await addDomain({ domain: 'other.test', fromName: 'Acme', fromLocalPart: 'talent' })).body.error.code).toBe('EMAIL_DOMAIN_EXISTS');

    await signIn(b.admin, b.org);
    const taken = await addDomain({ domain: 'acme.test', fromName: 'Globex', fromLocalPart: 'talent' });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('DOMAIN_TAKEN');
    // The platform's own sender domain (EMAIL_FROM in the test env is scheduling@slate.test).
    const reserved = await addDomain({ domain: 'slate.test', fromName: 'Globex', fromLocalPart: 'talent' });
    expect(reserved.status).toBe(422);
    expect(reserved.body.error.details.domain[0]).toBe('This domain is reserved.');
    const invalid = await addDomain({ domain: 'not a domain', fromName: 'Globex', fromLocalPart: 'talent' });
    expect(invalid.status).toBe(422);
    signOut();
  });

  it('explains when the server is not set up for custom domains', async () => {
    useResend(false);
    const w = await world();
    await signIn(w.admin, w.org);
    expect((await call(viewRoute, { path: '/x' })).body).toMatchObject({ available: false, domain: null });
    const res = await addDomain({ domain: 'acme.test', fromName: 'Acme', fromLocalPart: 'talent' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('EMAIL_DOMAINS_UNAVAILABLE');
    signOut();
  });

  it('asks candidates to reply to the calendar invitation (Yes / No / Maybe)', async () => {
    const w = await world();
    const message = await confirmationFor(w);
    expect(message.icalEvent?.method).toBe('REQUEST');
    const unfolded = message.icalEvent!.content.replace(/\r?\n /g, ''); // iCalendar folds long lines
    expect(unfolded).toContain(`ATTENDEE;CN="Riley Carter";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${message.to.email}`);
  });
});
