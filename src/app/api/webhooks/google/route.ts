import type { NextRequest } from 'next/server';
import { requestMeta } from '@/server/http/request';
import { verifyGoogleNotification } from '@/server/integrations/google/watch';
import { recordWebhook } from '@/server/integrations/webhooks';
import { enforceRateLimit, LIMITS } from '@/server/security/rate-limit';

/**
 * Google Calendar push notifications (events.watch).
 * Authenticated by the per-channel secret token we registered (X-Goog-Channel-Token).
 * Idempotent on (channel id, message number). Always answers quickly; work happens in a job.
 */
export async function POST(req: NextRequest) {
  try {
    await enforceRateLimit(`webhook:google:${requestMeta(req).ip}`, LIMITS.webhookPerIp.limit, LIMITS.webhookPerIp.window);
  } catch {
    return new Response(null, { status: 429 });
  }
  const headers = {
    channelId: req.headers.get('x-goog-channel-id'),
    channelToken: req.headers.get('x-goog-channel-token'),
    resourceId: req.headers.get('x-goog-resource-id'),
    resourceState: req.headers.get('x-goog-resource-state'),
    messageNumber: req.headers.get('x-goog-message-number'),
  };
  const channel = await verifyGoogleNotification(headers);
  if (!channel) {
    console.warn('[webhooks] rejected Google notification with unknown channel/token');
    return new Response(null, { status: 401 });
  }
  // "sync" is the handshake sent when a channel is created — nothing to do.
  if (headers.resourceState === 'sync') return new Response(null, { status: 204 });
  try {
    await recordWebhook(
      'google_calendar',
      `${headers.channelId}:${headers.messageNumber ?? Date.now()}`,
      `calendar.${headers.resourceState ?? 'change'}`,
      { channelId: headers.channelId, resourceState: headers.resourceState, messageNumber: headers.messageNumber },
    );
  } catch (err) {
    console.error('[webhooks] failed to record Google notification', err);
    return new Response(null, { status: 500 }); // Google retries with backoff
  }
  return new Response(null, { status: 204 });
}
