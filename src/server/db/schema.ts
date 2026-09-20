import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/*
 * Relational schema for the Calendor interview scheduling platform.
 *
 * Conventions:
 *  - Every tenant-owned row carries `organization_id`; repositories always filter on it.
 *  - All instants are `timestamptz` and stored in UTC. The IANA zone that gives an instant
 *    its human meaning is stored separately (e.g. `interviews.timezone`).
 *  - Secrets (OAuth tokens, Zoom host URLs, capability tokens) are stored encrypted
 *    (`*_encrypted`, AES-256-GCM) and/or hashed (`*_hash`, HMAC-SHA256) — never in plaintext.
 *
 * Constraints that Drizzle cannot express (btree_gist exclusion constraint preventing
 * overlapping interviews) live in hand-written migrations under /drizzle.
 */

const ts = () => timestamp({ withTimezone: true, mode: 'date' });
const tsNow = () => timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow();
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

// ---------------------------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------------------------

export const membershipRole = pgEnum('membership_role', ['admin', 'recruiter', 'interviewer']);
export const membershipStatus = pgEnum('membership_status', ['active', 'invited', 'deactivated']);
export const userStatus = pgEnum('user_status', ['active', 'deactivated']);
export const userTokenPurpose = pgEnum('user_token_purpose', ['email_verification', 'password_reset', 'invitation']);
export const interviewStatus = pgEnum('interview_status', ['scheduled', 'rescheduled', 'cancelled', 'completed', 'no_show']);
export const locationType = pgEnum('location_type', ['zoom', 'google_meet', 'phone', 'in_person', 'custom']);
export const eventVisibility = pgEnum('event_visibility', ['public', 'link_only']);
export const actorType = pgEnum('actor_type', ['user', 'candidate', 'system', 'webhook']);
export const bookingTokenPurpose = pgEnum('booking_token_purpose', ['view', 'reschedule', 'cancel']);
export const integrationProvider = pgEnum('integration_provider', ['google_calendar', 'zoom']);
export const integrationStatus = pgEnum('integration_status', ['active', 'error', 'disconnected']);
export const syncStatus = pgEnum('sync_status', ['pending', 'synced', 'failed', 'cancelled', 'deleted_externally']);
export const notificationStatus = pgEnum('notification_status', ['pending', 'queued', 'sent', 'failed', 'skipped']);
export const webhookStatus = pgEnum('webhook_status', ['received', 'processed', 'failed', 'ignored']);

export type MembershipRole = (typeof membershipRole.enumValues)[number];
export type InterviewStatus = (typeof interviewStatus.enumValues)[number];
export type LocationType = (typeof locationType.enumValues)[number];
export type IntegrationProvider = (typeof integrationProvider.enumValues)[number];
export type SyncStatus = (typeof syncStatus.enumValues)[number];
export type ActorType = (typeof actorType.enumValues)[number];

// ---------------------------------------------------------------------------------------------
// JSON column shapes
// ---------------------------------------------------------------------------------------------

export interface OrganizationSettings {
  /** Minutes before the interview when reminder emails are sent, e.g. [1440, 60]. */
  reminderOffsetsMinutes?: number[];
  candidateCanReschedule?: boolean;
  candidateCanCancel?: boolean;
  /** Candidates cannot reschedule/cancel within this many minutes of the start time. */
  candidateManageCutoffMinutes?: number;
  /**
   * Candidates are added as guests on the interviewer's Google Calendar event, so Google emails
   * them an invitation and the interview lands in their calendar (on unless set to false).
   */
  addCandidateAsCalendarAttendee?: boolean;
  /** Free-form policy shown on the public booking page. */
  bookingPageNotice?: string;
}

/** Whether candidates are invited as guests on the interviewer's Google Calendar event (default on). */
export function invitesCandidateAsCalendarGuest(settings: OrganizationSettings): boolean {
  return settings.addCandidateAsCalendarAttendee !== false;
}

/** A DNS record a business must add to send email from its own domain (as reported by the email provider). */
export interface EmailDnsRecord {
  type: string;
  name: string;
  value: string;
  priority: number | null;
  status: string | null;
}

export type FieldMode = 'hidden' | 'optional' | 'required';
export interface EventFieldConfig {
  phone: FieldMode;
  company: FieldMode;
  linkedinUrl: FieldMode;
  resumeUrl: FieldMode;
}

export type QuestionType = 'short_text' | 'long_text' | 'single_select' | 'url';
export interface CustomQuestion {
  id: string;
  label: string;
  type: QuestionType;
  required: boolean;
  options?: string[];
  helpText?: string;
}

export interface QuestionResponse {
  questionId: string;
  label: string;
  answer: string;
}

// ---------------------------------------------------------------------------------------------
// Tenancy & identity
// ---------------------------------------------------------------------------------------------

export const organizations = pgTable('organizations', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  logoUrl: text(),
  brandColor: text().notNull().default('#0e7c66'),
  defaultTimezone: text().notNull().default('UTC'),
  settings: jsonb().$type<OrganizationSettings>().notNull().default({}),
  createdAt: tsNow(),
  updatedAt: tsNow(),
});

export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    email: text().notNull(),
    name: text().notNull(),
    username: text().notNull(),
    passwordHash: text(),
    emailVerifiedAt: ts(),
    /**
     * When a platform admin approved the account. Self-service sign-ups start as null (pending) and
     * cannot sign in until approved; accounts created any other way (e.g. team invitations) are
     * approved on creation.
     */
    approvedAt: ts().defaultNow(),
    timezone: text().notNull().default('UTC'),
    title: text(),
    status: userStatus().notNull().default('active'),
    failedLoginAttempts: integer().notNull().default(0),
    lockedUntil: ts(),
    passwordChangedAt: ts(),
    lastLoginAt: ts(),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    uniqueIndex('users_email_unique').on(t.email),
    uniqueIndex('users_username_unique').on(t.username),
    check('users_email_lowercase', sql`${t.email} = lower(${t.email})`),
    check('users_username_format', sql`${t.username} ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'`),
  ],
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: membershipRole().notNull().default('interviewer'),
    status: membershipStatus().notNull().default('active'),
    invitedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    uniqueIndex('memberships_org_user_unique').on(t.organizationId, t.userId),
    index('memberships_user_idx').on(t.userId),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    tokenHash: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    activeOrganizationId: uuid().references(() => organizations.id, { onDelete: 'set null' }),
    ipAddress: text(),
    userAgent: text(),
    createdAt: tsNow(),
    lastSeenAt: tsNow(),
    expiresAt: ts().notNull(),
    revokedAt: ts(),
  },
  (t) => [uniqueIndex('sessions_token_hash_unique').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
);

/** Single-use tokens for email verification, password reset and team invitations. */
export const userTokens = pgTable(
  'user_tokens',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    purpose: userTokenPurpose().notNull(),
    tokenHash: text().notNull(),
    expiresAt: ts().notNull(),
    usedAt: ts(),
    createdAt: tsNow(),
  },
  (t) => [
    uniqueIndex('user_tokens_hash_unique').on(t.tokenHash),
    index('user_tokens_user_purpose_idx').on(t.userId, t.purpose),
  ],
);

// ---------------------------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------------------------

export const availabilitySchedules = pgTable(
  'availability_schedules',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    timezone: text().notNull(),
    isDefault: boolean().notNull().default(false),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    index('availability_schedules_user_idx').on(t.userId),
    uniqueIndex('availability_schedules_one_default_per_user')
      .on(t.userId, t.organizationId)
      .where(sql`${t.isDefault}`),
  ],
);

/** Weekly recurring working hours. Minutes are local wall-clock minutes in the schedule's zone. */
export const availabilityRules = pgTable(
  'availability_rules',
  {
    id: uuid().primaryKey().defaultRandom(),
    scheduleId: uuid()
      .notNull()
      .references(() => availabilitySchedules.id, { onDelete: 'cascade' }),
    /** ISO weekday: 1 = Monday … 7 = Sunday. */
    weekday: smallint().notNull(),
    startMinute: integer().notNull(),
    endMinute: integer().notNull(),
  },
  (t) => [
    index('availability_rules_schedule_idx').on(t.scheduleId),
    check('availability_rules_weekday_range', sql`${t.weekday} BETWEEN 1 AND 7`),
    check(
      'availability_rules_minutes_range',
      sql`${t.startMinute} >= 0 AND ${t.endMinute} <= 1440 AND ${t.startMinute} < ${t.endMinute}`,
    ),
  ],
);

/**
 * Date-specific overrides. For a given date, override rows replace the weekly rules.
 * A row with NULL start/end marks the whole date as unavailable (vacation, holiday).
 */
export const availabilityOverrides = pgTable(
  'availability_overrides',
  {
    id: uuid().primaryKey().defaultRandom(),
    scheduleId: uuid()
      .notNull()
      .references(() => availabilitySchedules.id, { onDelete: 'cascade' }),
    date: date({ mode: 'string' }).notNull(),
    startMinute: integer(),
    endMinute: integer(),
    note: text(),
  },
  (t) => [
    index('availability_overrides_schedule_date_idx').on(t.scheduleId, t.date),
    check(
      'availability_overrides_minutes_valid',
      sql`(${t.startMinute} IS NULL AND ${t.endMinute} IS NULL) OR (${t.startMinute} >= 0 AND ${t.endMinute} <= 1440 AND ${t.startMinute} < ${t.endMinute})`,
    ),
  ],
);

/** Organisation-wide non-working days applied to every member's availability. */
export const organizationHolidays = pgTable(
  'organization_holidays',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    date: date({ mode: 'string' }).notNull(),
    name: text().notNull(),
    createdAt: tsNow(),
  },
  (t) => [uniqueIndex('organization_holidays_org_date_unique').on(t.organizationId, t.date)],
);

/**
 * Uploaded organisation logo. Kept out of `organizations` so the blob is never loaded with the
 * org row; `organizations.logo_url` points at the public route that serves it.
 */
export const organizationLogos = pgTable('organization_logos', {
  organizationId: uuid()
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  contentType: text().notNull(),
  data: bytea().notNull(),
  sha256: text().notNull(),
  updatedById: uuid().references(() => users.id, { onDelete: 'set null' }),
  updatedAt: tsNow(),
});

/**
 * A business's own email sending domain (e.g. acme.com), registered with the email provider
 * (Resend). Once its DNS records verify, the organisation's interview emails are sent from
 * `from_local_part@domain`; until then they use the platform sender (EMAIL_FROM).
 */
export const organizationEmailDomains = pgTable('organization_email_domains', {
  organizationId: uuid()
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  domain: text().notNull().unique(),
  providerDomainId: text().notNull(),
  status: text().notNull().default('not_started'),
  records: jsonb().$type<EmailDnsRecord[]>().notNull().default([]),
  fromName: text().notNull(),
  fromLocalPart: text().notNull().default('scheduling'),
  verifiedAt: ts(),
  lastCheckedAt: ts(),
  createdAt: tsNow(),
  updatedAt: tsNow(),
});

// ---------------------------------------------------------------------------------------------
// Event types & scheduling links
// ---------------------------------------------------------------------------------------------

export const eventTypes = pgTable(
  'event_types',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    hostUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    scheduleId: uuid().references(() => availabilitySchedules.id, { onDelete: 'set null' }),
    slug: text().notNull(),
    name: text().notNull(),
    description: text(),
    color: text().notNull().default('#0e7c66'),
    durationMinutes: integer().notNull(),
    locationType: locationType().notNull().default('zoom'),
    locationDetails: text(),
    bufferBeforeMinutes: integer().notNull().default(0),
    bufferAfterMinutes: integer().notNull().default(0),
    minimumNoticeMinutes: integer().notNull().default(240),
    maxDaysInFuture: integer().default(60),
    slotIntervalMinutes: integer(),
    dailyLimit: integer(),
    isActive: boolean().notNull().default(true),
    visibility: eventVisibility().notNull().default('public'),
    questions: jsonb().$type<CustomQuestion[]>().notNull().default([]),
    fieldConfig: jsonb()
      .$type<EventFieldConfig>()
      .notNull()
      .default({ phone: 'optional', company: 'hidden', linkedinUrl: 'optional', resumeUrl: 'optional' }),
    reminderOffsetsMinutes: jsonb().$type<number[] | null>(),
    createdAt: tsNow(),
    updatedAt: tsNow(),
    deletedAt: ts(),
  },
  (t) => [
    uniqueIndex('event_types_host_slug_unique')
      .on(t.hostUserId, t.slug)
      .where(sql`${t.deletedAt} IS NULL`),
    index('event_types_org_idx').on(t.organizationId),
    index('event_types_host_idx').on(t.hostUserId),
    check('event_types_duration_range', sql`${t.durationMinutes} BETWEEN 5 AND 720`),
    check(
      'event_types_buffers_range',
      sql`${t.bufferBeforeMinutes} BETWEEN 0 AND 240 AND ${t.bufferAfterMinutes} BETWEEN 0 AND 240`,
    ),
    check('event_types_slug_format', sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$'`),
  ],
);

/**
 * Personal scheduling links (e.g. single-use links sent to one candidate). They grant the
 * holder the ability to book the linked event type — including `link_only` event types —
 * and can expire, be limited in use count, or be revoked.
 */
export const schedulingLinks = pgTable(
  'scheduling_links',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventTypeId: uuid()
      .notNull()
      .references(() => eventTypes.id, { onDelete: 'cascade' }),
    createdById: uuid().references(() => users.id, { onDelete: 'set null' }),
    label: text(),
    tokenHash: text().notNull(),
    tokenEncrypted: text().notNull(),
    candidateName: text(),
    candidateEmail: text(),
    maxUses: integer(),
    useCount: integer().notNull().default(0),
    expiresAt: ts(),
    revokedAt: ts(),
    createdAt: tsNow(),
  },
  (t) => [
    uniqueIndex('scheduling_links_token_hash_unique').on(t.tokenHash),
    index('scheduling_links_event_type_idx').on(t.eventTypeId),
  ],
);

// ---------------------------------------------------------------------------------------------
// Candidates & interviews
// ---------------------------------------------------------------------------------------------

export const candidates = pgTable(
  'candidates',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text().notNull(),
    name: text().notNull(),
    phone: text(),
    company: text(),
    linkedinUrl: text(),
    resumeUrl: text(),
    timezone: text(),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    uniqueIndex('candidates_org_email_unique').on(t.organizationId, t.email),
    index('candidates_email_idx').on(t.email),
    check('candidates_email_lowercase', sql`${t.email} = lower(${t.email})`),
  ],
);

export const interviews = pgTable(
  'interviews',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventTypeId: uuid()
      .notNull()
      .references(() => eventTypes.id, { onDelete: 'restrict' }),
    hostUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    candidateId: uuid()
      .notNull()
      .references(() => candidates.id, { onDelete: 'restrict' }),
    schedulingLinkId: uuid().references(() => schedulingLinks.id, { onDelete: 'set null' }),
    title: text().notNull(),
    startAt: ts().notNull(),
    endAt: ts().notNull(),
    bufferBeforeMinutes: integer().notNull().default(0),
    bufferAfterMinutes: integer().notNull().default(0),
    /** Host/schedule zone at booking time. */
    timezone: text().notNull(),
    /** Zone the candidate booked in; used when rendering candidate-facing emails. */
    candidateTimezone: text().notNull(),
    status: interviewStatus().notNull().default('scheduled'),
    locationType: locationType().notNull(),
    locationDetails: text(),
    responses: jsonb().$type<QuestionResponse[]>().notNull().default([]),
    source: text({ enum: ['public_page', 'scheduling_link', 'dashboard'] }).notNull(),
    idempotencyKey: text(),
    /** Incremented on every change that must be propagated to integrations. */
    version: integer().notNull().default(1),
    rescheduleCount: integer().notNull().default(0),
    cancelReason: text(),
    cancelledAt: ts(),
    cancelledByType: actorType(),
    cancelledByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    completedAt: ts(),
    /** Lease used to ensure one integration sync per interview runs at a time. */
    syncLeaseUntil: ts(),
    syncLeaseOwner: text(),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    index('interviews_host_start_idx').on(t.hostUserId, t.startAt),
    index('interviews_org_start_idx').on(t.organizationId, t.startAt),
    index('interviews_org_end_idx').on(t.organizationId, t.endAt),
    index('interviews_org_status_idx').on(t.organizationId, t.status),
    index('interviews_candidate_idx').on(t.candidateId),
    index('interviews_event_type_idx').on(t.eventTypeId),
    uniqueIndex('interviews_idempotency_unique')
      .on(t.eventTypeId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    check('interviews_time_order', sql`${t.endAt} > ${t.startAt}`),
  ],
);

/** Immutable history of every reschedule, preserving the original times. */
export const interviewReschedules = pgTable(
  'interview_reschedules',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    interviewId: uuid()
      .notNull()
      .references(() => interviews.id, { onDelete: 'cascade' }),
    previousStartAt: ts().notNull(),
    previousEndAt: ts().notNull(),
    newStartAt: ts().notNull(),
    newEndAt: ts().notNull(),
    actorType: actorType().notNull(),
    actorUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    reason: text(),
    createdAt: tsNow(),
  },
  (t) => [index('interview_reschedules_interview_idx').on(t.interviewId)],
);

/**
 * Capability tokens emailed to candidates (view / reschedule / cancel). The hash is used for
 * lookup; the encrypted copy lets later emails (e.g. reminders) re-render the same links.
 */
export const bookingTokens = pgTable(
  'booking_tokens',
  {
    id: uuid().primaryKey().defaultRandom(),
    interviewId: uuid()
      .notNull()
      .references(() => interviews.id, { onDelete: 'cascade' }),
    purpose: bookingTokenPurpose().notNull(),
    tokenHash: text().notNull(),
    tokenEncrypted: text().notNull(),
    expiresAt: ts().notNull(),
    revokedAt: ts(),
    lastUsedAt: ts(),
    createdAt: tsNow(),
  },
  (t) => [
    uniqueIndex('booking_tokens_hash_unique').on(t.tokenHash),
    uniqueIndex('booking_tokens_interview_purpose_unique').on(t.interviewId, t.purpose),
  ],
);

// ---------------------------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------------------------

export const integrations = pgTable(
  'integrations',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: integrationProvider().notNull(),
    status: integrationStatus().notNull().default('active'),
    externalAccountId: text().notNull(),
    externalAccountEmail: text(),
    accessTokenEncrypted: text(),
    refreshTokenEncrypted: text(),
    tokenExpiresAt: ts(),
    scopes: text().array().notNull().default(sql`ARRAY[]::text[]`),
    lastError: text(),
    lastErrorAt: ts(),
    connectedAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    uniqueIndex('integrations_user_provider_unique').on(t.userId, t.provider),
    index('integrations_provider_account_idx').on(t.provider, t.externalAccountId),
    index('integrations_org_idx').on(t.organizationId),
  ],
);

/** Calendars available on a connected calendar account and how each one is used. */
export const integrationCalendars = pgTable(
  'integration_calendars',
  {
    id: uuid().primaryKey().defaultRandom(),
    integrationId: uuid()
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    externalCalendarId: text().notNull(),
    name: text().notNull(),
    timezone: text(),
    isPrimary: boolean().notNull().default(false),
    accessRole: text(),
    color: text(),
    checkConflicts: boolean().notNull().default(false),
    isWriteTarget: boolean().notNull().default(false),
  },
  (t) => [
    uniqueIndex('integration_calendars_unique').on(t.integrationId, t.externalCalendarId),
    uniqueIndex('integration_calendars_one_write_target')
      .on(t.integrationId)
      .where(sql`${t.isWriteTarget}`),
  ],
);

/** Google Calendar push-notification channels (events.watch). */
export const calendarWatchChannels = pgTable(
  'calendar_watch_channels',
  {
    id: uuid().primaryKey().defaultRandom(),
    integrationId: uuid()
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    externalCalendarId: text().notNull(),
    channelId: text().notNull(),
    resourceId: text(),
    tokenHash: text().notNull(),
    syncToken: text(),
    lastMessageNumber: bigint({ mode: 'number' }),
    expiresAt: ts().notNull(),
    createdAt: tsNow(),
  },
  (t) => [
    uniqueIndex('calendar_watch_channels_channel_unique').on(t.channelId),
    index('calendar_watch_channels_integration_idx').on(t.integrationId),
  ],
);

/** The interviewer-calendar event mirroring an interview. */
export const calendarEvents = pgTable(
  'calendar_events',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    interviewId: uuid()
      .notNull()
      .references(() => interviews.id, { onDelete: 'cascade' }),
    integrationId: uuid().references(() => integrations.id, { onDelete: 'set null' }),
    provider: integrationProvider().notNull(),
    externalCalendarId: text(),
    externalEventId: text(),
    htmlLink: text(),
    status: syncStatus().notNull().default('pending'),
    syncedVersion: integer().notNull().default(0),
    attempts: integer().notNull().default(0),
    lastError: text(),
    lastAttemptAt: ts(),
    syncedAt: ts(),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    uniqueIndex('calendar_events_interview_provider_unique').on(t.interviewId, t.provider),
    index('calendar_events_external_idx').on(t.provider, t.externalEventId),
    index('calendar_events_status_idx').on(t.status),
  ],
);

/** The video meeting (Zoom today; Google Meet / Teams later) attached to an interview. */
export const videoMeetings = pgTable(
  'video_meetings',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    interviewId: uuid()
      .notNull()
      .references(() => interviews.id, { onDelete: 'cascade' }),
    integrationId: uuid().references(() => integrations.id, { onDelete: 'set null' }),
    provider: integrationProvider().notNull(),
    externalMeetingId: text(),
    joinUrl: text(),
    passcode: text(),
    /** Host start URL — grants host control of the meeting, so encrypted and never sent to candidates. */
    hostUrlEncrypted: text(),
    status: syncStatus().notNull().default('pending'),
    syncedVersion: integer().notNull().default(0),
    attempts: integer().notNull().default(0),
    lastError: text(),
    lastAttemptAt: ts(),
    syncedAt: ts(),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    uniqueIndex('video_meetings_interview_unique').on(t.interviewId),
    index('video_meetings_external_idx').on(t.provider, t.externalMeetingId),
    index('video_meetings_status_idx').on(t.status),
  ],
);

/** OAuth authorization requests in flight (state + PKCE verifier), bound to the initiating user. */
export const oauthStates = pgTable(
  'oauth_states',
  {
    id: uuid().primaryKey().defaultRandom(),
    stateHash: text().notNull(),
    provider: integrationProvider().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    codeVerifierEncrypted: text().notNull(),
    returnTo: text(),
    expiresAt: ts().notNull(),
    usedAt: ts(),
    createdAt: tsNow(),
  },
  (t) => [uniqueIndex('oauth_states_hash_unique').on(t.stateHash)],
);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid().primaryKey().defaultRandom(),
    provider: integrationProvider().notNull(),
    dedupeKey: text().notNull(),
    eventType: text().notNull(),
    status: webhookStatus().notNull().default('received'),
    attempts: integer().notNull().default(0),
    error: text(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    receivedAt: tsNow(),
    processedAt: ts(),
  },
  (t) => [
    uniqueIndex('webhook_events_dedupe_unique').on(t.provider, t.dedupeKey),
    index('webhook_events_status_idx').on(t.status, t.receivedAt),
  ],
);

// ---------------------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------------------

export const notificationTypes = [
  'booking_confirmation',
  'host_booking_notification',
  'reschedule_confirmation',
  'host_reschedule_notification',
  'cancellation',
  'host_cancellation_notification',
  'reminder',
  'meeting_details_update',
] as const;
export type NotificationType = (typeof notificationTypes)[number];

export const notifications = pgTable(
  'notifications',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    interviewId: uuid().references(() => interviews.id, { onDelete: 'cascade' }),
    type: text({ enum: notificationTypes }).notNull(),
    channel: text({ enum: ['email'] })
      .notNull()
      .default('email'),
    recipientType: text({ enum: ['candidate', 'host'] }).notNull(),
    recipientEmail: text().notNull(),
    recipientName: text(),
    status: notificationStatus().notNull().default('pending'),
    /** Interview version this notification describes; stale notifications are skipped. */
    interviewVersion: integer(),
    /** Confirmation-style emails wait for the first integration sync so they can include the meeting link. */
    waitForSync: boolean().notNull().default(false),
    scheduledFor: tsNow(),
    sentAt: ts(),
    attempts: integer().notNull().default(0),
    lastError: text(),
    providerMessageId: text(),
    dedupeKey: text().notNull(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    uniqueIndex('notifications_dedupe_unique').on(t.dedupeKey),
    index('notifications_interview_idx').on(t.interviewId),
    index('notifications_status_scheduled_idx').on(t.status, t.scheduledFor),
  ],
);

/** Organisation-level customisation of transactional email copy. */
export const notificationTemplates = pgTable(
  'notification_templates',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    type: text({ enum: notificationTypes }).notNull(),
    subject: text(),
    intro: text(),
    enabled: boolean().notNull().default(true),
    updatedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    updatedAt: tsNow(),
  },
  (t) => [uniqueIndex('notification_templates_org_type_unique').on(t.organizationId, t.type)],
);

// ---------------------------------------------------------------------------------------------
// Audit & infrastructure
// ---------------------------------------------------------------------------------------------

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    actorType: actorType().notNull(),
    actorUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    actorLabel: text(),
    action: text().notNull(),
    resourceType: text().notNull(),
    resourceId: text(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    ipAddress: text(),
    userAgent: text(),
    createdAt: tsNow(),
  },
  (t) => [
    index('audit_logs_org_created_idx').on(t.organizationId, t.createdAt.desc()),
    index('audit_logs_resource_idx').on(t.resourceType, t.resourceId),
    index('audit_logs_actor_idx').on(t.actorUserId),
    index('audit_logs_action_idx').on(t.organizationId, t.action),
  ],
);

/** Fixed-window counters backing the distributed rate limiter. */
export const rateLimits = pgTable(
  'rate_limits',
  {
    key: text().notNull(),
    windowStart: ts().notNull(),
    count: integer().notNull().default(0),
    expiresAt: ts().notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] }), index('rate_limits_expires_idx').on(t.expiresAt)],
);

// ---------------------------------------------------------------------------------------------
// Relations (for the relational query API)
// ---------------------------------------------------------------------------------------------

export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(memberships),
  eventTypes: many(eventTypes),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
  integrations: many(integrations),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  organization: one(organizations, { fields: [memberships.organizationId], references: [organizations.id] }),
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
}));

export const availabilitySchedulesRelations = relations(availabilitySchedules, ({ many, one }) => ({
  rules: many(availabilityRules),
  overrides: many(availabilityOverrides),
  user: one(users, { fields: [availabilitySchedules.userId], references: [users.id] }),
}));

export const availabilityRulesRelations = relations(availabilityRules, ({ one }) => ({
  schedule: one(availabilitySchedules, { fields: [availabilityRules.scheduleId], references: [availabilitySchedules.id] }),
}));

export const availabilityOverridesRelations = relations(availabilityOverrides, ({ one }) => ({
  schedule: one(availabilitySchedules, {
    fields: [availabilityOverrides.scheduleId],
    references: [availabilitySchedules.id],
  }),
}));

export const eventTypesRelations = relations(eventTypes, ({ one, many }) => ({
  organization: one(organizations, { fields: [eventTypes.organizationId], references: [organizations.id] }),
  host: one(users, { fields: [eventTypes.hostUserId], references: [users.id] }),
  schedule: one(availabilitySchedules, { fields: [eventTypes.scheduleId], references: [availabilitySchedules.id] }),
  schedulingLinks: many(schedulingLinks),
}));

export const schedulingLinksRelations = relations(schedulingLinks, ({ one }) => ({
  eventType: one(eventTypes, { fields: [schedulingLinks.eventTypeId], references: [eventTypes.id] }),
}));

export const interviewsRelations = relations(interviews, ({ one, many }) => ({
  organization: one(organizations, { fields: [interviews.organizationId], references: [organizations.id] }),
  eventType: one(eventTypes, { fields: [interviews.eventTypeId], references: [eventTypes.id] }),
  host: one(users, { fields: [interviews.hostUserId], references: [users.id] }),
  candidate: one(candidates, { fields: [interviews.candidateId], references: [candidates.id] }),
  calendarEvents: many(calendarEvents),
  videoMeeting: one(videoMeetings, { fields: [interviews.id], references: [videoMeetings.interviewId] }),
  reschedules: many(interviewReschedules),
  tokens: many(bookingTokens),
  notifications: many(notifications),
}));

export const interviewReschedulesRelations = relations(interviewReschedules, ({ one }) => ({
  interview: one(interviews, { fields: [interviewReschedules.interviewId], references: [interviews.id] }),
  actor: one(users, { fields: [interviewReschedules.actorUserId], references: [users.id] }),
}));

export const calendarEventsRelations = relations(calendarEvents, ({ one }) => ({
  interview: one(interviews, { fields: [calendarEvents.interviewId], references: [interviews.id] }),
  integration: one(integrations, { fields: [calendarEvents.integrationId], references: [integrations.id] }),
}));

export const videoMeetingsRelations = relations(videoMeetings, ({ one }) => ({
  interview: one(interviews, { fields: [videoMeetings.interviewId], references: [interviews.id] }),
  integration: one(integrations, { fields: [videoMeetings.integrationId], references: [integrations.id] }),
}));

export const integrationsRelations = relations(integrations, ({ one, many }) => ({
  user: one(users, { fields: [integrations.userId], references: [users.id] }),
  calendars: many(integrationCalendars),
  watchChannels: many(calendarWatchChannels),
}));

export const integrationCalendarsRelations = relations(integrationCalendars, ({ one }) => ({
  integration: one(integrations, { fields: [integrationCalendars.integrationId], references: [integrations.id] }),
}));

export const calendarWatchChannelsRelations = relations(calendarWatchChannels, ({ one }) => ({
  integration: one(integrations, { fields: [calendarWatchChannels.integrationId], references: [integrations.id] }),
}));

export const bookingTokensRelations = relations(bookingTokens, ({ one }) => ({
  interview: one(interviews, { fields: [bookingTokens.interviewId], references: [interviews.id] }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  interview: one(interviews, { fields: [notifications.interviewId], references: [interviews.id] }),
}));

export const candidatesRelations = relations(candidates, ({ many }) => ({
  interviews: many(interviews),
}));

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  actor: one(users, { fields: [auditLogs.actorUserId], references: [users.id] }),
}));
