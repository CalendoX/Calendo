import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { PATCH as orgSettingsRoute } from '@/app/api/admin/organization/route';
import { DELETE as removeLogoRoute, POST as uploadLogoRoute } from '@/app/api/admin/organization/logo/route';
import { POST as bookRoute } from '@/app/api/public/book/[username]/[eventSlug]/route';
import { GET as logoRoute } from '@/app/api/public/organizations/[id]/logo/route';
import { db } from '@/server/db/client';
import { auditLogs, organizationLogos, organizations } from '@/server/db/schema';
import { deliverDueNotifications } from '../helpers/db';
import { createEventType, createMember, createOrg, signIn, signOut, upcomingWeekday, type Org } from '../helpers/fixtures';
import { call } from '../helpers/http';
import { outbox } from '../helpers/outbox';

// A 1×1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

function logoForm(bytes: Uint8Array, filename = 'logo.png', type = 'image/png') {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(bytes)], filename, { type }));
  return form;
}

function upload(bytes: Uint8Array, opts: { origin?: string; filename?: string; type?: string } = {}) {
  return call(uploadLogoRoute, { path: '/api/admin/organization/logo', body: logoForm(bytes, opts.filename, opts.type), origin: opts.origin });
}

/** Fetches the public logo route and returns the raw bytes (call() decodes bodies as text). */
async function fetchLogo(path: string, orgId: string) {
  const res = await logoRoute(new NextRequest(new URL(path, 'http://localhost:3000')), { params: Promise.resolve({ id: orgId }) });
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
}

async function orgRow(org: Org) {
  const [row] = await db.select().from(organizations).where(eq(organizations.id, org.id));
  return row;
}

async function adminOf(org: Org) {
  const admin = await createMember(org, { role: 'admin' });
  await signIn(admin);
  return admin;
}

describe('organisation logo upload', () => {
  it('stores an uploaded logo and serves it from a versioned public URL', async () => {
    const org = await createOrg();
    await adminOf(org);

    const res = await upload(PNG);
    expect(res.status).toBe(200);
    expect(res.body.logoUrl).toMatch(new RegExp(`^/api/public/organizations/${org.id}/logo\\?v=[0-9a-f]{16}$`));
    expect((await orgRow(org)).logoUrl).toBe(res.body.logoUrl);

    const served = await fetchLogo(res.body.logoUrl, org.id);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('cache-control')).toContain('immutable');
    expect(served.bytes.equals(PNG)).toBe(true);

    // An outdated version still resolves (e.g. in old emails) but is only cached briefly.
    const stale = await fetchLogo(`/api/public/organizations/${org.id}/logo?v=0000000000000000`, org.id);
    expect(stale.status).toBe(200);
    expect(stale.headers.get('cache-control')).toBe('public, max-age=300');

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, 'organization.logo_updated'));
    expect(audit).toMatchObject({ organizationId: org.id, metadata: { contentType: 'image/png', bytes: PNG.length } });
  });

  it('replacing the logo changes its URL so browsers and email clients fetch the new image', async () => {
    const org = await createOrg();
    await adminOf(org);
    const first = await upload(PNG);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
    const second = await upload(jpeg, { filename: 'logo.jpg', type: 'image/jpeg' });
    expect(second.status).toBe(200);
    expect(second.body.logoUrl).not.toBe(first.body.logoUrl);
    const served = await fetchLogo(second.body.logoUrl, org.id);
    expect(served.headers.get('content-type')).toBe('image/jpeg');
    expect(await db.select().from(organizationLogos).where(eq(organizationLogos.organizationId, org.id))).toHaveLength(1);
  });

  it('rejects files that are not images, whatever they claim to be', async () => {
    const org = await createOrg();
    await adminOf(org);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    for (const bytes of [Buffer.from('definitely not a png'), svg]) {
      const res = await upload(bytes);
      expect(res.status).toBe(422);
      expect(res.body.error.details.file[0]).toBe('Upload a PNG, JPG, WebP or GIF image.');
    }
    expect((await orgRow(org)).logoUrl).toBeNull();
  });

  it('rejects logos larger than 1 MB and empty uploads', async () => {
    const org = await createOrg();
    await adminOf(org);
    const huge = Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]);
    const tooBig = await upload(huge);
    expect(tooBig.status).toBe(422);
    expect(tooBig.body.error.details.file[0]).toBe('The logo must be 1 MB or smaller.');

    const empty = await call(uploadLogoRoute, { path: '/api/admin/organization/logo', body: new FormData() });
    expect(empty.status).toBe(422);
    expect(empty.body.error.details.file[0]).toBe('Choose an image to upload.');
  });

  it('only admins can change the logo, and only from the app origin', async () => {
    const org = await createOrg();
    const interviewer = await createMember(org, { role: 'interviewer' });
    await signIn(interviewer);
    expect((await upload(PNG)).status).toBe(403);
    expect((await call(removeLogoRoute, { method: 'DELETE', path: '/api/admin/organization/logo' })).status).toBe(403);

    await adminOf(org);
    expect((await upload(PNG, { origin: 'https://evil.example' })).status).toBe(403);
    signOut();
    expect((await upload(PNG)).status).toBe(401);
    expect((await orgRow(org)).logoUrl).toBeNull();
  });

  it('removing the logo falls back to the organisation name', async () => {
    const org = await createOrg();
    await adminOf(org);
    const { body } = await upload(PNG);
    const res = await call(removeLogoRoute, { method: 'DELETE', path: '/api/admin/organization/logo' });
    expect(res.status).toBe(200);
    expect((await orgRow(org)).logoUrl).toBeNull();
    expect((await fetchLogo(body.logoUrl, org.id)).status).toBe(404);
  });

  it('saving the other organisation settings keeps the uploaded logo', async () => {
    const org = await createOrg();
    await adminOf(org);
    const { body } = await upload(PNG);
    const res = await call(orgSettingsRoute, {
      method: 'PATCH',
      path: '/api/admin/organization',
      body: {
        name: 'Renamed Org',
        brandColor: '#0e7c66',
        logoUrl: null,
        defaultTimezone: 'America/New_York',
        settings: { reminderOffsetsMinutes: [1440], candidateCanReschedule: true, candidateCanCancel: true, candidateManageCutoffMinutes: 60, addCandidateAsCalendarAttendee: false },
      },
    });
    expect(res.status).toBe(200);
    expect(await orgRow(org)).toMatchObject({ name: 'Renamed Org', logoUrl: body.logoUrl });
  });

  it('returns 404 for unknown organisations and malformed ids', async () => {
    expect((await fetchLogo('/x', randomUUID())).status).toBe(404);
    expect((await fetchLogo('/x', 'not-a-uuid')).status).toBe(404);
  });

  it('emails reference the uploaded logo by absolute URL', async () => {
    const org = await createOrg({ name: 'Northwind Labs' });
    await adminOf(org);
    const { body } = await upload(PNG);
    signOut();
    const host = await createMember(org, { role: 'interviewer', timezone: 'America/New_York' });
    const eventType = await createEventType(org, host);
    const email = `c-${randomUUID().slice(0, 6)}@candidate.test`;
    const res = await call(bookRoute, {
      path: '/x',
      params: { username: host.username, eventSlug: eventType.slug },
      body: { start: upcomingWeekday('America/New_York', '10:00').toISOString(), name: 'Riley Carter', email, timezone: 'Europe/London', answers: {} },
      origin: false,
    });
    expect(res.status).toBe(201);
    await deliverDueNotifications();
    const [confirmation] = outbox.to(email);
    expect(confirmation.html).toContain(`<img src="http://localhost:3000${body.logoUrl}"`);
  });
});
