import { and, eq, gt, inArray } from 'drizzle-orm';
import { db, type Executor } from '../db/client';
import {
  calendarEvents,
  integrationCalendars,
  integrations,
  interviews,
  videoMeetings,
  type IntegrationProvider,
} from '../db/schema';
import { ServiceUnavailableError } from '../http/errors';
import { enqueueInterviewSync } from '../jobs/queue';
import type { TimeRange } from '../scheduling/engine';
import { decrypt, encrypt } from '../security/crypto';
import { recordAudit } from '../services/audit';
import { listEventsInRange, type ExternalEventDetails } from './google/calendar';
import { calendarProviders, conferencingProviders, oauthAdapters } from './registry';
import {
  IntegrationError,
  isIntegrationError,
  type AccessTokenSource,
  type CalendarEventInput,
  type CalendarEventResult,
  type MeetingInput,
  type MeetingResult,
} from './types';

/**
 * IntegrationService — the only entry point the scheduling system uses to talk to third-party
 * providers. It owns credential handling (decrypt, refresh with row-level locking, error
 * state), and exposes provider-agnostic operations:
 *
 *   getAvailability()                           → busy time across connected calendars
 *   createMeeting() / updateMeeting() / cancelMeeting()
 *   createCalendarEvent() / updateCalendarEvent() / cancelCalendarEvent()
 *
 * Tokens never leave the server: nothing in this module returns credentials to callers that
 * serialise responses.
 */

export type IntegrationRow = typeof integrations.$inferSelect;

const REFRESH_SKEW_MS = 60_000;

export async function getIntegration(userId: string, provider: IntegrationProvider, executor: Executor = db) {
  const [row] = await executor
    .select()
    .from(integrations)
    .where(and(eq(integrations.userId, userId), eq(integrations.provider, provider)))
    .limit(1);
  return row ?? null;
}

export async function getActiveIntegration(userId: string, provider: IntegrationProvider, executor: Executor = db) {
  const row = await getIntegration(userId, provider, executor);
  return row && row.status === 'active' ? row : null;
}

// ---------------------------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------------------------

export async function markIntegrationError(integrationId: string, message: string) {
  const [row] = await db
    .update(integrations)
    .set({ status: 'error', lastError: message.slice(0, 1000), lastErrorAt: new Date(), updatedAt: new Date() })
    .where(eq(integrations.id, integrationId))
    .returning();
  if (row) {
    await recordAudit({
      organizationId: row.organizationId,
      actor: { type: 'system', label: 'Integration monitor' },
      action: 'integration.failure',
      resourceType: 'integration',
      resourceId: row.id,
      metadata: { provider: row.provider, error: message.slice(0, 500), requiresReconnect: true },
    });
  }
}

async function refreshAccessToken(integrationId: string, rejectedToken: string | null): Promise<string> {
  try {
    return await db.transaction(async (tx) => {
      // Serialise refreshes: providers like Zoom rotate refresh tokens, so two concurrent
      // refreshes with the same token would invalidate each other.
      const [row] = await tx.select().from(integrations).where(eq(integrations.id, integrationId)).for('update');
      if (!row || row.status === 'disconnected') {
        throw new IntegrationError(row?.provider ?? 'google_calendar', 'not_connected', 'Integration is not connected');
      }
      if (row.accessTokenEncrypted && row.tokenExpiresAt && row.tokenExpiresAt.getTime() > Date.now() + REFRESH_SKEW_MS) {
        const stored = decrypt(row.accessTokenEncrypted);
        if (stored !== rejectedToken) return stored; // someone else refreshed while we waited
      }
      if (!row.refreshTokenEncrypted) {
        throw new IntegrationError(row.provider, 'auth', 'No refresh token stored — the account must be reconnected');
      }
      const tokens = await oauthAdapters[row.provider].refreshTokens(decrypt(row.refreshTokenEncrypted));
      await tx
        .update(integrations)
        .set({
          accessTokenEncrypted: encrypt(tokens.accessToken),
          refreshTokenEncrypted: tokens.refreshToken ? encrypt(tokens.refreshToken) : row.refreshTokenEncrypted,
          tokenExpiresAt: tokens.expiresAt,
          status: 'active',
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(integrations.id, integrationId));
      return tokens.accessToken;
    });
  } catch (err) {
    if (isIntegrationError(err) && err.kind === 'auth') {
      await markIntegrationError(integrationId, `Authorization expired or was revoked: ${err.message}`);
    }
    throw err;
  }
}

async function getValidAccessToken(integrationId: string): Promise<string> {
  const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId)).limit(1);
  if (!row) throw new IntegrationError('google_calendar', 'not_connected', 'Integration is not connected');
  if (row.status !== 'active') {
    throw new IntegrationError(row.provider, row.status === 'error' ? 'auth' : 'not_connected', row.lastError ?? 'Integration needs to be reconnected');
  }
  if (row.accessTokenEncrypted && (!row.tokenExpiresAt || row.tokenExpiresAt.getTime() > Date.now() + REFRESH_SKEW_MS)) {
    return decrypt(row.accessTokenEncrypted);
  }
  return refreshAccessToken(integrationId, null);
}

export function tokenSourceFor(integrationId: string): AccessTokenSource {
  let current: string | null = null;
  return {
    async get() {
      current = await getValidAccessToken(integrationId);
      return current;
    },
    async refresh() {
      current = await refreshAccessToken(integrationId, current);
      return current;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Availability (calendar busy time)
// ---------------------------------------------------------------------------------------------

export interface CalendarBusyResult {
  connected: boolean;
  busy: TimeRange[];
}

const busyCache = new Map<string, { at: number; busy: TimeRange[] }>();
const overlayCache = new Map<string, { at: number; overlay: CalendarOverlay }>();
const BUSY_CACHE_TTL_MS = 30_000;

export function invalidateBusyCache(integrationId?: string) {
  if (!integrationId) {
    busyCache.clear();
    overlayCache.clear();
    return;
  }
  for (const cache of [busyCache, overlayCache]) {
    for (const key of cache.keys()) if (key.startsWith(`${integrationId}:`)) cache.delete(key);
  }
}

export class CalendarUnavailableError extends ServiceUnavailableError {
  constructor(message = "The interviewer's calendar can't be checked right now, so availability can't be confirmed. Please try again in a few minutes.") {
    super(message, 'CALENDAR_UNAVAILABLE');
  }
}

/**
 * Busy time for a host across every calendar marked "check for conflicts".
 *
 * Fails closed: if the host has a calendar connected but it cannot be read (outage, revoked
 * access), this throws CalendarUnavailableError instead of pretending the calendar is empty.
 * `allowCache` is used for browsing availability only — booking-time checks always go live.
 */
export async function getAvailability(
  hostUserId: string,
  range: TimeRange,
  opts: { allowCache?: boolean } = {},
): Promise<CalendarBusyResult> {
  const integration = await getIntegration(hostUserId, 'google_calendar');
  if (!integration) return { connected: false, busy: [] };
  if (integration.status !== 'active') {
    throw new CalendarUnavailableError();
  }
  const calendars = await db
    .select({ id: integrationCalendars.externalCalendarId })
    .from(integrationCalendars)
    .where(and(eq(integrationCalendars.integrationId, integration.id), eq(integrationCalendars.checkConflicts, true)));
  if (calendars.length === 0) return { connected: true, busy: [] };

  const cacheKey = `${integration.id}:${range.start}:${range.end}`;
  if (opts.allowCache) {
    const hit = busyCache.get(cacheKey);
    if (hit && Date.now() - hit.at < BUSY_CACHE_TTL_MS) return { connected: true, busy: hit.busy };
  }

  const provider = calendarProviders[integration.provider]!;
  try {
    const busy = await provider.getBusy(tokenSourceFor(integration.id), {
      calendarIds: calendars.map((c) => c.id),
      start: new Date(range.start),
      end: new Date(range.end),
    });
    busyCache.set(cacheKey, { at: Date.now(), busy });
    if (busyCache.size > 500) busyCache.delete(busyCache.keys().next().value!);
    return { connected: true, busy };
  } catch (err) {
    console.warn(`[integrations] free/busy failed for integration ${integration.id}:`, (err as Error).message);
    if (isIntegrationError(err) && err.kind !== 'auth') {
      await db
        .update(integrations)
        .set({ lastError: err.message.slice(0, 1000), lastErrorAt: new Date() })
        .where(eq(integrations.id, integration.id));
    }
    throw new CalendarUnavailableError();
  }
}

export interface CalendarOverlay {
  connected: boolean;
  /** Events (with titles and guests) from calendars the user can read. */
  events: (ExternalEventDetails & { calendarName: string })[];
  /** Busy blocks from calendars shared with the user as free/busy only. */
  busy: TimeRange[];
}

/**
 * The user's *own* Google Calendar for Calendor's calendar view: event details from every
 * "check for conflicts" calendar they can read, and plain busy blocks for calendars shared with
 * them as free/busy only (or whose events can't be read). Never used to show one person's
 * events to anyone else.
 */
export async function getCalendarOverlay(userId: string, range: TimeRange, zone: string): Promise<CalendarOverlay> {
  const integration = await getIntegration(userId, 'google_calendar');
  if (!integration) return { connected: false, events: [], busy: [] };
  if (integration.status !== 'active') throw new CalendarUnavailableError();
  const calendars = await db
    .select({ id: integrationCalendars.externalCalendarId, name: integrationCalendars.name, accessRole: integrationCalendars.accessRole })
    .from(integrationCalendars)
    .where(and(eq(integrationCalendars.integrationId, integration.id), eq(integrationCalendars.checkConflicts, true)));
  if (calendars.length === 0) return { connected: true, events: [], busy: [] };

  const cacheKey = `${integration.id}:${range.start}:${range.end}:${zone}`;
  const hit = overlayCache.get(cacheKey);
  if (hit && Date.now() - hit.at < BUSY_CACHE_TTL_MS) return hit.overlay;

  const token = tokenSourceFor(integration.id);
  const span = { start: new Date(range.start), end: new Date(range.end) };
  try {
    const perCalendar = await Promise.all(
      calendars.map(async (c) => {
        if (c.accessRole === 'freeBusyReader') return { busyOnly: c.id };
        try {
          const events = await listEventsInRange(token, c.id, span, zone);
          return { events: events.map((e) => ({ ...e, calendarName: c.name })) };
        } catch (err) {
          if (isIntegrationError(err) && err.kind === 'auth') throw err;
          return { busyOnly: c.id };
        }
      }),
    );
    const busyOnlyIds = perCalendar.flatMap((r) => (r.busyOnly ? [r.busyOnly] : []));
    const busy = busyOnlyIds.length ? await calendarProviders.google_calendar!.getBusy(token, { calendarIds: busyOnlyIds, ...span }) : [];
    // An invitation shows up (with the same id) on every calendar it's on; list it once.
    const seen = new Set<string>();
    const events = perCalendar
      .flatMap((r) => r.events ?? [])
      .filter((e) => !seen.has(e.id) && seen.add(e.id))
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    const overlay = { connected: true, events, busy };
    overlayCache.set(cacheKey, { at: Date.now(), overlay });
    if (overlayCache.size > 200) overlayCache.delete(overlayCache.keys().next().value!);
    return overlay;
  } catch (err) {
    console.warn(`[integrations] calendar overlay failed for integration ${integration.id}:`, (err as Error).message);
    throw new CalendarUnavailableError();
  }
}

// ---------------------------------------------------------------------------------------------
// Meetings & calendar events (provider-agnostic wrappers)
// ---------------------------------------------------------------------------------------------

function conferencing(provider: IntegrationProvider) {
  const p = conferencingProviders[provider];
  if (!p) throw new IntegrationError(provider, 'permanent', `${provider} does not support meetings`);
  return p;
}

function calendar(provider: IntegrationProvider) {
  const p = calendarProviders[provider];
  if (!p) throw new IntegrationError(provider, 'permanent', `${provider} does not support calendars`);
  return p;
}

export function createMeeting(integration: IntegrationRow, input: MeetingInput): Promise<MeetingResult> {
  return conferencing(integration.provider).createMeeting(tokenSourceFor(integration.id), input);
}

export function updateMeeting(integration: IntegrationRow, externalMeetingId: string, input: MeetingInput) {
  return conferencing(integration.provider).updateMeeting(tokenSourceFor(integration.id), externalMeetingId, input);
}

export function cancelMeeting(integration: IntegrationRow, externalMeetingId: string) {
  return conferencing(integration.provider).cancelMeeting(tokenSourceFor(integration.id), externalMeetingId);
}

export function getMeetingHostUrl(integration: IntegrationRow, externalMeetingId: string) {
  return conferencing(integration.provider).getHostUrl(tokenSourceFor(integration.id), externalMeetingId);
}

export function createCalendarEvent(
  integration: IntegrationRow,
  calendarId: string,
  input: CalendarEventInput,
): Promise<CalendarEventResult> {
  return calendar(integration.provider).createEvent(tokenSourceFor(integration.id), calendarId, input);
}

export function updateCalendarEvent(
  integration: IntegrationRow,
  calendarId: string,
  externalEventId: string,
  input: CalendarEventInput,
) {
  return calendar(integration.provider).updateEvent(tokenSourceFor(integration.id), calendarId, externalEventId, input);
}

export function cancelCalendarEvent(integration: IntegrationRow, calendarId: string, externalEventId: string, notify: boolean) {
  return calendar(integration.provider).cancelEvent(tokenSourceFor(integration.id), calendarId, externalEventId, notify);
}

export async function getWriteCalendar(integrationId: string, executor: Executor = db) {
  const [row] = await executor
    .select()
    .from(integrationCalendars)
    .where(and(eq(integrationCalendars.integrationId, integrationId), eq(integrationCalendars.isWriteTarget, true)))
    .limit(1);
  return row ?? null;
}

/**
 * After (re)connecting an integration, retry every upcoming interview whose meeting / calendar
 * event is pending or failed, so earlier failures heal automatically.
 */
export async function resyncFailedForUser(userId: string, provider: IntegrationProvider) {
  const table = provider === 'zoom' ? videoMeetings : calendarEvents;
  const rows = await db
    .select({ id: interviews.id })
    .from(interviews)
    .innerJoin(table, eq(table.interviewId, interviews.id))
    .where(
      and(
        eq(interviews.hostUserId, userId),
        inArray(interviews.status, ['scheduled', 'rescheduled', 'cancelled']),
        inArray(table.status, ['failed', 'pending']),
        gt(interviews.endAt, new Date()),
      ),
    );
  for (const r of rows) await enqueueInterviewSync(r.id, `${provider}_reconnected`);
  return rows.length;
}
