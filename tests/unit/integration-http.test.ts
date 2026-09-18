import { afterEach, describe, expect, it } from 'vitest';
import { authedRequest, classifyFailure, setIntegrationFetch } from '@/server/integrations/http';
import { googleEventIdFor } from '@/server/integrations/google/calendar';
import { zoomStartTime } from '@/server/integrations/zoom/meetings';
import { IntegrationError } from '@/server/integrations/types';

afterEach(() => setIntegrationFetch(null));

const headers = (h: Record<string, string> = {}) => new Headers(h);

describe('provider error classification', () => {
  it('maps HTTP failures onto retry semantics', () => {
    expect(classifyFailure('zoom', 401, {}, headers(), 'x').kind).toBe('auth');
    expect(classifyFailure('zoom', 404, { code: 3001 }, headers(), 'x').kind).toBe('not_found');
    expect(classifyFailure('google_calendar', 410, {}, headers(), 'x').kind).toBe('not_found');
    expect(classifyFailure('google_calendar', 409, {}, headers(), 'x').kind).toBe('conflict');
    expect(classifyFailure('zoom', 400, { message: 'Invalid field' }, headers(), 'x').kind).toBe('permanent');
    const limited = classifyFailure('zoom', 429, {}, headers({ 'retry-after': '42' }), 'x');
    expect(limited).toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 42, retryable: true });
    expect(classifyFailure('google_calendar', 503, {}, headers(), 'x')).toMatchObject({ kind: 'transient', retryable: true });
  });

  it("recognises Google's 403 quota errors as rate limiting, other 403s as permanent", () => {
    const quota = { error: { code: 403, message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] } };
    expect(classifyFailure('google_calendar', 403, quota, headers(), 'x').kind).toBe('rate_limited');
    expect(classifyFailure('google_calendar', 403, { error: { message: 'Forbidden' } }, headers(), 'x').kind).toBe('permanent');
  });

  it('extracts a readable provider message', () => {
    const err = classifyFailure('google_calendar', 400, { error: { message: 'Invalid start time' } }, headers(), 'Create Google Calendar event');
    expect(err.message).toBe('Create Google Calendar event failed (400): Invalid start time');
  });
});

describe('authenticated requests', () => {
  it('refreshes once on 401 and retries with the new token', async () => {
    const seen: string[] = [];
    setIntegrationFetch(async (_url, init) => {
      const auth = new Headers(init?.headers).get('authorization')!;
      seen.push(auth);
      return auth === 'Bearer fresh' ? Response.json({ ok: true }) : new Response('{}', { status: 401 });
    });
    let refreshes = 0;
    const token = { get: async () => 'stale', refresh: async () => (refreshes++, 'fresh') };
    const res = await authedRequest<{ ok: boolean }>('zoom', token, { url: 'https://api.zoom.us/v2/users/me' }, 'Fetch');
    expect(res.data).toEqual({ ok: true });
    expect(seen).toEqual(['Bearer stale', 'Bearer fresh']);
    expect(refreshes).toBe(1);
  });

  it('gives up with an auth error if the refreshed token is also rejected', async () => {
    setIntegrationFetch(async () => new Response('{}', { status: 401 }));
    const token = { get: async () => 'a', refresh: async () => 'b' };
    const err = await authedRequest('zoom', token, { url: 'https://api.zoom.us/v2/users/me' }, 'Fetch').catch((e) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect(err.kind).toBe('auth');
  });

  it('turns network failures into retryable transient errors', async () => {
    setIntegrationFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const err = await authedRequest('google_calendar', { get: async () => 't', refresh: async () => 't' }, { url: 'https://www.googleapis.com/x' }, 'X').catch((e) => e);
    expect(err).toMatchObject({ kind: 'transient', retryable: true });
  });
});

describe('provider payload helpers', () => {
  it('derives a Google-valid, deterministic event id from the interview id', () => {
    const id = googleEventIdFor('3F2504E0-4F89-11D3-9A0C-0305E82C3301');
    expect(id).toBe('slate3f2504e04f8911d39a0c0305e82c3301');
    // Google event ids: base32hex characters (a–v, 0–9), 5–1024 long.
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
  });

  it('formats Zoom start times as UTC with a Z suffix', () => {
    expect(zoomStartTime(new Date('2026-11-01T06:30:00.000Z'))).toBe('2026-11-01T06:30:00Z');
  });
});
