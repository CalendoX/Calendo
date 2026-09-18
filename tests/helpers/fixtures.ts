import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { hashPassword } from '../../src/server/auth/password';
import { createSession, sessionCookieName } from '../../src/server/auth/session';
import { db } from '../../src/server/db/client';
import {
  eventTypes,
  memberships,
  organizations,
  users,
  type CustomQuestion,
  type EventFieldConfig,
  type MembershipRole,
  type OrganizationSettings,
} from '../../src/server/db/schema';
import { createDefaultSchedule } from '../../src/server/services/auth-service';
import { cookieJar } from './cookie-jar';

/**
 * Test data builders. Everything is created through the same tables the application uses;
 * each test starts with an empty database (see integration-setup.ts).
 */

export const TEST_PASSWORD = 'Correct-Horse-Battery-9';
let passwordHash: Promise<string> | null = null;
const hashed = () => (passwordHash ??= hashPassword(TEST_PASSWORD));

export type Org = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type EventType = typeof eventTypes.$inferSelect;

export async function createOrg(overrides: { name?: string; settings?: OrganizationSettings } = {}): Promise<Org> {
  const suffix = randomUUID().slice(0, 8);
  const [org] = await db
    .insert(organizations)
    .values({
      name: overrides.name ?? `Acme ${suffix}`,
      slug: `acme-${suffix}`,
      defaultTimezone: 'America/New_York',
      settings: {
        reminderOffsetsMinutes: [1440, 60],
        candidateCanReschedule: true,
        candidateCanCancel: true,
        candidateManageCutoffMinutes: 60,
        ...overrides.settings,
      },
    })
    .returning();
  return org;
}

export async function createMember(
  org: Org,
  opts: { role?: MembershipRole; name?: string; timezone?: string; status?: 'active' | 'invited' | 'deactivated'; verified?: boolean } = {},
): Promise<User> {
  const suffix = randomUUID().slice(0, 8);
  const role = opts.role ?? 'interviewer';
  const timezone = opts.timezone ?? 'America/New_York';
  const [user] = await db
    .insert(users)
    .values({
      email: `${role}-${suffix}@example.test`,
      name: opts.name ?? `Test ${role} ${suffix}`,
      username: `${role}-${suffix}`,
      passwordHash: await hashed(),
      timezone,
      emailVerifiedAt: opts.verified === false ? null : new Date(),
      passwordChangedAt: new Date(Date.now() - 60_000),
    })
    .returning();
  await db.insert(memberships).values({ organizationId: org.id, userId: user.id, role, status: opts.status ?? 'active' });
  // Mon–Fri 09:00–17:00 in the member's zone, like every newly created account.
  await createDefaultSchedule(db, user.id, org.id, timezone);
  return user;
}

export async function createEventType(
  org: Org,
  host: User,
  overrides: Partial<{
    name: string;
    slug: string;
    durationMinutes: number;
    locationType: 'zoom' | 'phone' | 'in_person' | 'custom';
    locationDetails: string | null;
    bufferBeforeMinutes: number;
    bufferAfterMinutes: number;
    minimumNoticeMinutes: number;
    maxDaysInFuture: number | null;
    isActive: boolean;
    visibility: 'public' | 'link_only';
    questions: CustomQuestion[];
    fieldConfig: EventFieldConfig;
    reminderOffsetsMinutes: number[] | null;
    dailyLimit: number | null;
  }> = {},
): Promise<EventType> {
  const [row] = await db
    .insert(eventTypes)
    .values({
      organizationId: org.id,
      hostUserId: host.id,
      name: overrides.name ?? 'Technical Interview',
      slug: overrides.slug ?? 'technical-interview',
      durationMinutes: overrides.durationMinutes ?? 60,
      locationType: overrides.locationType ?? 'phone',
      locationDetails: overrides.locationDetails ?? null,
      bufferBeforeMinutes: overrides.bufferBeforeMinutes ?? 0,
      bufferAfterMinutes: overrides.bufferAfterMinutes ?? 0,
      minimumNoticeMinutes: overrides.minimumNoticeMinutes ?? 60,
      maxDaysInFuture: overrides.maxDaysInFuture === undefined ? 60 : overrides.maxDaysInFuture,
      isActive: overrides.isActive ?? true,
      visibility: overrides.visibility ?? 'public',
      questions: overrides.questions ?? [],
      fieldConfig: overrides.fieldConfig ?? { phone: 'optional', company: 'hidden', linkedinUrl: 'optional', resumeUrl: 'optional' },
      reminderOffsetsMinutes: overrides.reminderOffsetsMinutes ?? null,
      dailyLimit: overrides.dailyLimit ?? null,
    })
    .returning();
  return row;
}

/** Signs a user in (a real session row) and places the cookie in the request cookie jar. */
export async function signIn(user: User, org?: Org) {
  const session = await createSession(user.id, org?.id ?? null, { ip: '127.0.0.1', userAgent: 'vitest' });
  cookieJar.set(sessionCookieName(), session.token, { httpOnly: true, sameSite: 'lax', path: '/' });
  return session;
}

export function signOut() {
  cookieJar.clear();
}

/**
 * A weekday (Mon–Fri) at local `time` in `zone`, at least `minDaysAhead` days from now — safely
 * inside default working hours and outside minimum notice windows.
 */
export function upcomingWeekday(zone: string, time: string, minDaysAhead = 3): Date {
  const [hour, minute] = time.split(':').map(Number);
  let d = DateTime.now().setZone(zone).plus({ days: minDaysAhead }).startOf('day');
  while (d.weekday > 5) d = d.plus({ days: 1 });
  return d.set({ hour, minute }).toJSDate();
}

export function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
}
