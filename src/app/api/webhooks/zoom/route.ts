import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { zoomConfig } from '@/server/config/env';
import { requestMeta } from '@/server/http/request';
import { recordWebhook } from '@/server/integrations/webhooks';
import { verifyZoomSignature, zoomUrlValidationResponse } from '@/server/integrations/zoom/webhooks';
import { enforceRateLimit, LIMITS } from '@/server/security/rate-limit';

/**
 * Zoom Event Subscriptions endpoint (meeting.deleted, meeting.updated, app_deauthorized, and the
 * endpoint.url_validation challenge). Every request must carry a valid x-zm-signature.
 */
export async function POST(req: NextRequest) {
  try {
    await enforceRateLimit(`webhook:zoom:${requestMeta(req).ip}`, LIMITS.webhookPerIp.limit, LIMITS.webhookPerIp.window);
  } catch {
    return new Response(null, { status: 429 });
  }
  const secret = zoomConfig()?.webhookSecretToken;
  if (!secret) return NextResponse.json({ error: 'Zoom webhooks are not configured' }, { status: 503 });
  const rawBody = await req.text();
  if (rawBody.length > 512 * 1024) return new Response(null, { status: 413 });
  const valid = verifyZoomSignature({
    rawBody,
    timestamp: req.headers.get('x-zm-request-timestamp'),
    signature: req.headers.get('x-zm-signature'),
    secret,
  });
  if (!valid) {
    console.warn('[webhooks] rejected Zoom webhook with invalid signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }
  let body: { event?: string; payload?: Record<string, unknown>; event_ts?: number };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Malformed JSON' }, { status: 400 });
  }
  if (body.event === 'endpoint.url_validation') {
    const plainToken = String((body.payload as { plainToken?: string } | undefined)?.plainToken ?? '');
    if (!plainToken) return NextResponse.json({ error: 'Missing plainToken' }, { status: 400 });
    return NextResponse.json(zoomUrlValidationResponse(plainToken, secret));
  }
  const dedupeKey = createHash('sha256').update(rawBody).digest('hex');
  try {
    await recordWebhook('zoom', dedupeKey, body.event ?? 'unknown', body as Record<string, unknown>);
  } catch (err) {
    console.error('[webhooks] failed to record Zoom event', err);
    return new Response(null, { status: 500 });
  }
  return new Response(null, { status: 204 });
}
