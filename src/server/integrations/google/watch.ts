import { randomUUID } from 'node:crypto';
import { and, eq, inArray, lt, or } from 'drizzle-orm';
import { webhookBaseUrl } from '../../config/env';
import { db } from '../../db/client';
import { calendarEvents, calendarWatchChannels, integrationCalendars, integrations, interviews } from '../../db/schema';
import { hashToken, randomToken, safeEqual } from '../../security/crypto';
import { recordAudit } from '../../services/audit';
import { invalidateBusyCache, tokenSourceFor } from '../service';
import { listChangedEvents, stopWatchChannel, watchCalendarEvents } from './calendar';

/**
 * Google Calendar push notifications.
 *
 * We watch every calendar used for conflicts or as the interview write target. Notifications
 * tell us "something changed" (no payload); we then pull the incremental change feed with a
 * sync token to (a) drop cached free/busy data and (b) detect interview events that the
 * interviewer deleted or moved directly in Google Calendar.
 *
 * Google requires a publicly reachable HTTPS endpoint, so channels are only registered when
 * WEBHOOK_BASE_URL (or APP_URL) is https.
 */

const CHANNEL_TTL_SECONDS = 7 * 24 * 60 * 60;
const RENEW_BEFORE_MS = 48 * 60 * 60 * 1000;

export function pushNotificationsSupported() {
  return webhookBaseUrl().startsWith('https://');
}

export async function ensureWatchChannels(integrationId: string) {
  if (!pushNotificationsSupported()) return { registered: 0, skipped: 'webhook base URL is not https' as const };
  const calendars = await db
    .select()
    .from(integrationCalendars)
    .where(
      and(
        eq(integrationCalendars.integrationId, integrationId),
        or(eq(integrationCalendars.checkConflicts, true), eq(integrationCalendars.isWriteTarget, true)),
      ),
    );
  const channels = await db.select().from(calendarWatchChannels).where(eq(calendarWatchChannels.integrationId, integrationId));
  const wanted = new Set(calendars.map((c) => c.externalCalendarId));
  const token = tokenSourceFor(integrationId);
  let registered = 0;

  // Stop channels for calendars that are no longer used.
  for (const ch of channels.filter((c) => !wanted.has(c.externalCalendarId))) {
    if (ch.resourceId) await stopWatchChannel(token, ch.channelId, ch.resourceId).catch(() => undefined);
    await db.delete(calendarWatchChannels).where(eq(calendarWatchChannels.id, ch.id));
  }

  for (const cal of calendars) {
    const current = channels.find((c) => c.externalCalendarId === cal.externalCalendarId);
    if (current && current.expiresAt.getTime() - Date.now() > RENEW_BEFORE_MS) continue;
    const channelId = randomUUID();
    const channelToken = randomToken(24);
    const result = await watchCalendarEvents(token, cal.externalCalendarId, {
      channelId,
      address: `${webhookBaseUrl()}/api/webhooks/google`,
      channelToken,
      ttlSeconds: CHANNEL_TTL_SECONDS,
    });
    // Prime the incremental sync token so the first notification only reports new changes.
    const initial = await listChangedEvents(token, cal.externalCalendarId, null).catch(() => null);
    await db.insert(calendarWatchChannels).values({
      integrationId,
      externalCalendarId: cal.externalCalendarId,
      channelId,
      resourceId: result.resourceId,
      tokenHash: hashToken(channelToken),
      syncToken: initial?.nextSyncToken ?? current?.syncToken ?? null,
      expiresAt: result.expiration,
    });
    if (current) {
      if (current.resourceId) await stopWatchChannel(token, current.channelId, current.resourceId).catch(() => undefined);
      await db.delete(calendarWatchChannels).where(eq(calendarWatchChannels.id, current.id));
    }
    registered++;
  }
  return { registered };
}

/** Cron: renew channels that expire soon, for every active Google integration. */
export async function renewExpiringChannels() {
  if (!pushNotificationsSupported()) return { renewed: 0 };
  const soon = new Date(Date.now() + RENEW_BEFORE_MS);
  const active = await db
    .select({ id: integrations.id })
    .from(integrations)
    .where(and(eq(integrations.provider, 'google_calendar'), eq(integrations.status, 'active')));
  const expiring = await db
    .select({ integrationId: calendarWatchChannels.integrationId })
    .from(calendarWatchChannels)
    .where(lt(calendarWatchChannels.expiresAt, soon));
  const ids = new Set([...expiring.map((e) => e.integrationId)]);
  // Also cover integrations that have no channels at all (e.g. registration failed earlier).
  const withChannels = new Set((await db.select({ id: calendarWatchChannels.integrationId }).from(calendarWatchChannels)).map((r) => r.id));
  for (const a of active) if (!withChannels.has(a.id)) ids.add(a.id);
  let renewed = 0;
  for (const id of ids) {
    if (!active.some((a) => a.id === id)) continue;
    try {
      renewed += (await ensureWatchChannels(id)).registered ?? 0;
    } catch (err) {
      console.warn(`[google] channel renewal failed for integration ${id}:`, (err as Error).message);
    }
  }
  return { renewed };
}

export interface GoogleNotificationHeaders {
  channelId: string | null;
  channelToken: string | null;
  resourceId: string | null;
  resourceState: string | null;
  messageNumber: string | null;
}

/** Authenticates a push notification against the stored channel. */
export async function verifyGoogleNotification(h: GoogleNotificationHeaders) {
  if (!h.channelId || !h.channelToken) return null;
  const [channel] = await db.select().from(calendarWatchChannels).where(eq(calendarWatchChannels.channelId, h.channelId)).limit(1);
  if (!channel) return null;
  if (!safeEqual(channel.tokenHash, hashToken(h.channelToken))) return null;
  if (channel.resourceId && h.resourceId && channel.resourceId !== h.resourceId) return null;
  return channel;
}

/**
 * Processes changes on a watched calendar: invalidates busy caches and flags interview events
 * that were deleted or moved outside Calendo (we never silently reschedule the candidate).
 */
export async function processCalendarChanges(channelId: string) {
  const [channel] = await db.select().from(calendarWatchChannels).where(eq(calendarWatchChannels.channelId, channelId)).limit(1);
  if (!channel) return { processed: 0, reason: 'channel_not_found' };
  const [integration] = await db.select().from(integrations).where(eq(integrations.id, channel.integrationId)).limit(1);
  if (!integration || integration.status !== 'active') return { processed: 0, reason: 'integration_inactive' };
  invalidateBusyCache(integration.id);

  const token = tokenSourceFor(integration.id);
  let result = await listChangedEvents(token, channel.externalCalendarId, channel.syncToken);
  if (result.reset) result = await listChangedEvents(token, channel.externalCalendarId, null);

  const ours = result.events.filter((e) => e.interviewId || e.id.startsWith('slate'));
  let flagged = 0;
  if (ours.length) {
    const rows = await db
      .select({ event: calendarEvents, interview: interviews })
      .from(calendarEvents)
      .innerJoin(interviews, eq(interviews.id, calendarEvents.interviewId))
      .where(
        and(
          eq(calendarEvents.provider, 'google_calendar'),
          inArray(
            calendarEvents.externalEventId,
            ours.map((e) => e.id),
          ),
        ),
      );
    for (const { event, interview } of rows) {
      const change = ours.find((e) => e.id === event.externalEventId)!;
      const active = interview.status === 'scheduled' || interview.status === 'rescheduled';
      if (!active || event.status !== 'synced') continue;
      if (change.status === 'cancelled') {
        await db
          .update(calendarEvents)
          .set({ status: 'deleted_externally', lastError: 'The event was deleted directly in Google Calendar.', updatedAt: new Date() })
          .where(eq(calendarEvents.id, event.id));
        await recordAudit({
          organizationId: interview.organizationId,
          actor: { type: 'webhook', label: 'Google Calendar' },
          action: 'integration.external_change',
          resourceType: 'interview',
          resourceId: interview.id,
          metadata: { provider: 'google_calendar', change: 'event_deleted', externalEventId: event.externalEventId },
        });
        flagged++;
      } else if (change.start && change.end && (change.start.getTime() !== interview.startAt.getTime() || change.end.getTime() !== interview.endAt.getTime())) {
        await recordAudit({
          organizationId: interview.organizationId,
          actor: { type: 'webhook', label: 'Google Calendar' },
          action: 'integration.external_change',
          resourceType: 'interview',
          resourceId: interview.id,
          metadata: {
            provider: 'google_calendar',
            change: 'event_moved',
            externalStart: change.start.toISOString(),
            externalEnd: change.end.toISOString(),
            note: 'The calendar event was moved in Google Calendar. The interview time is unchanged; reschedule in Calendo to notify the candidate.',
          },
        });
        flagged++;
      }
    }
  }

  if (result.nextSyncToken) {
    await db.update(calendarWatchChannels).set({ syncToken: result.nextSyncToken }).where(eq(calendarWatchChannels.id, channel.id));
  }
  return { processed: result.events.length, flagged };
}
