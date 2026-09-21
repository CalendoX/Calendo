import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { integrations, interviews, videoMeetings } from '../../db/schema';
import { hmacSha256Hex, safeEqual } from '../../security/crypto';
import { recordAudit } from '../../services/audit';

/**
 * Zoom webhook handling (Event Subscriptions).
 *
 * Signature: x-zm-signature = "v0=" + HMAC_SHA256(secretToken, "v0:{timestamp}:{rawBody}").
 * Requests older than 5 minutes are rejected to prevent replay.
 */

const MAX_SKEW_MS = 5 * 60 * 1000;

export function verifyZoomSignature(params: { rawBody: string; timestamp: string | null; signature: string | null; secret: string; now?: number }) {
  const { rawBody, timestamp, signature, secret } = params;
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const tsMs = ts < 1e12 ? ts * 1000 : ts;
  if (Math.abs((params.now ?? Date.now()) - tsMs) > MAX_SKEW_MS) return false;
  const expected = `v0=${hmacSha256Hex(secret, `v0:${timestamp}:${rawBody}`)}`;
  return safeEqual(expected, signature);
}

export function zoomUrlValidationResponse(plainToken: string, secret: string) {
  return { plainToken, encryptedToken: hmacSha256Hex(secret, plainToken) };
}

interface ZoomEventPayload {
  event: string;
  event_ts?: number;
  payload?: {
    account_id?: string;
    user_id?: string;
    object?: { id?: number | string; uuid?: string; host_id?: string; start_time?: string; topic?: string };
    old_object?: { start_time?: string };
  };
}

export async function handleZoomEvent(body: ZoomEventPayload): Promise<'processed' | 'ignored'> {
  switch (body.event) {
    case 'meeting.deleted': {
      const meetingId = body.payload?.object?.id;
      if (!meetingId) return 'ignored';
      const rows = await db
        .select({ meeting: videoMeetings, interview: interviews })
        .from(videoMeetings)
        .innerJoin(interviews, eq(interviews.id, videoMeetings.interviewId))
        .where(and(eq(videoMeetings.provider, 'zoom'), eq(videoMeetings.externalMeetingId, String(meetingId))));
      let touched = 0;
      for (const { meeting, interview } of rows) {
        const active = interview.status === 'scheduled' || interview.status === 'rescheduled';
        if (!active || meeting.status !== 'synced') continue; // our own deletions arrive here too
        await db
          .update(videoMeetings)
          .set({ status: 'deleted_externally', lastError: 'The meeting was deleted directly in Zoom.', updatedAt: new Date() })
          .where(eq(videoMeetings.id, meeting.id));
        await recordAudit({
          organizationId: interview.organizationId,
          actor: { type: 'webhook', label: 'Zoom' },
          action: 'integration.external_change',
          resourceType: 'interview',
          resourceId: interview.id,
          metadata: { provider: 'zoom', change: 'meeting_deleted', meetingId: String(meetingId) },
        });
        touched++;
      }
      return touched ? 'processed' : 'ignored';
    }
    case 'meeting.updated': {
      const meetingId = body.payload?.object?.id;
      const newStart = body.payload?.object?.start_time;
      if (!meetingId || !newStart) return 'ignored';
      const rows = await db
        .select({ interview: interviews })
        .from(videoMeetings)
        .innerJoin(interviews, eq(interviews.id, videoMeetings.interviewId))
        .where(and(eq(videoMeetings.provider, 'zoom'), eq(videoMeetings.externalMeetingId, String(meetingId))));
      for (const { interview } of rows) {
        if (new Date(newStart).getTime() === interview.startAt.getTime()) continue;
        await recordAudit({
          organizationId: interview.organizationId,
          actor: { type: 'webhook', label: 'Zoom' },
          action: 'integration.external_change',
          resourceType: 'interview',
          resourceId: interview.id,
          metadata: {
            provider: 'zoom',
            change: 'meeting_time_changed',
            externalStart: newStart,
            note: 'The Zoom meeting time was changed in Zoom. The interview time is unchanged.',
          },
        });
      }
      return rows.length ? 'processed' : 'ignored';
    }
    case 'app_deauthorized': {
      const zoomUserId = body.payload?.user_id;
      if (!zoomUserId) return 'ignored';
      const rows = await db
        .update(integrations)
        .set({
          status: 'error',
          accessTokenEncrypted: null,
          refreshTokenEncrypted: null,
          lastError: 'Calendo was removed from the Zoom account. Reconnect Zoom to create meetings.',
          lastErrorAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(integrations.provider, 'zoom'), eq(integrations.externalAccountId, zoomUserId)))
        .returning();
      for (const row of rows) {
        await recordAudit({
          organizationId: row.organizationId,
          actor: { type: 'webhook', label: 'Zoom' },
          action: 'integration.disconnected',
          resourceType: 'integration',
          resourceId: row.id,
          metadata: { provider: 'zoom', reason: 'app_deauthorized' },
        });
      }
      return rows.length ? 'processed' : 'ignored';
    }
    default:
      return 'ignored';
  }
}
