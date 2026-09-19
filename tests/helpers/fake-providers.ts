import { createHash } from 'node:crypto';

/**
 * In-process fakes of the Google (OAuth, userinfo, Calendar v3) and Zoom (OAuth, REST v2) HTTP
 * APIs, installed via setIntegrationFetch(). They enforce the contracts the real providers do —
 * PKCE verification, client authentication, bearer-token validation (401 on expired tokens),
 * Zoom refresh-token rotation, Google's 409 on duplicate event ids and 410 on deleted events —
 * so tests exercise the production provider code end to end, including token refresh and
 * error classification. Failures can be injected per endpoint.
 */

type ProviderName = 'google' | 'zoom';

export interface RecordedCall {
  provider: ProviderName;
  method: string;
  url: URL;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

interface InjectedFailure {
  provider: ProviderName;
  method?: string;
  path: RegExp;
  times: number;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  networkError?: boolean;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const noContent = () => new Response(null, { status: 204 });

function s256(verifier: string) {
  return createHash('sha256').update(verifier).digest('base64url');
}

function parseBody(init?: RequestInit): unknown {
  const raw = init?.body;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

function normaliseHeaders(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (out[k] = v));
  return out;
}

function bearer(headers: Record<string, string>) {
  const auth = headers.authorization ?? '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

// ---------------------------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------------------------

export interface FakeGoogleEvent {
  id: string;
  calendarId: string;
  status: 'confirmed' | 'cancelled';
  summary?: string;
  description?: string;
  location?: string;
  /** `date` for all-day events, `dateTime` otherwise. */
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  transparency?: 'opaque' | 'transparent';
  hangoutLink?: string;
  organizer?: { email: string; displayName?: string };
  attendees?: { email: string; displayName?: string; responseStatus?: string; organizer?: boolean; resource?: boolean; self?: boolean }[];
  extendedProperties?: { private?: Record<string, string> };
  sendUpdates?: string | null;
}

export const GOOGLE_FULL_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

class FakeGoogle {
  account = { sub: '109876543210', email: 'priya.interviews@gmail.test', name: 'Priya Nair' };
  calendars = [
    { id: 'primary-cal@gmail.test', summary: 'Priya Nair', primary: true, timeZone: 'America/New_York', accessRole: 'owner', backgroundColor: '#1a73e8' },
    { id: 'team-holidays@group.calendar.google.com', summary: 'Team holidays', primary: false, timeZone: 'America/New_York', accessRole: 'reader', backgroundColor: '#0b8043' },
  ];
  /** Busy blocks per calendar id (as Google's freeBusy would report them). */
  busy = new Map<string, { start: string; end: string }[]>();
  /** Calendars whose free/busy lookup reports an error (e.g. 'backendError'). */
  freeBusyErrors = new Map<string, string>();
  /** Calendars whose event listing is refused (403), e.g. details not shared with the user. */
  eventsForbidden = new Set<string>();
  events = new Map<string, FakeGoogleEvent>();
  channels = new Map<string, { calendarId: string; token: string; address: string; resourceId: string }>();
  revoked: string[] = [];

  private codes = new Map<string, { challenge: string; scopes: string[]; redirectUri: string }>();
  private accessTokens = new Set<string>();
  private refreshTokens = new Set<string>();
  private changeLog: { seq: number; eventId: string }[] = [];
  private seq = 0;
  private counter = 0;

  /** Simulates the user completing Google's consent screen for an authorization URL we issued. */
  authorize(authorizationUrl: string, opts: { scopes?: string[] } = {}) {
    const url = new URL(authorizationUrl);
    const code = `g-code-${++this.counter}`;
    this.codes.set(code, {
      challenge: url.searchParams.get('code_challenge') ?? '',
      scopes: opts.scopes ?? GOOGLE_FULL_SCOPES,
      redirectUri: url.searchParams.get('redirect_uri') ?? '',
    });
    return { code, state: url.searchParams.get('state') ?? '' };
  }

  /** Every issued access token stops working (as if they had all expired). */
  expireAccessTokens() {
    this.accessTokens.clear();
  }

  /** The user revoked access in their Google account: refreshing now fails with invalid_grant. */
  revokeGrant() {
    this.accessTokens.clear();
    this.refreshTokens.clear();
  }

  setBusy(calendarId: string, blocks: { start: Date; end: Date }[]) {
    this.busy.set(calendarId, blocks.map((b) => ({ start: b.start.toISOString(), end: b.end.toISOString() })));
  }

  /** The interviewer deletes/moves an event directly in Google Calendar. */
  deleteEventExternally(eventId: string) {
    const e = this.events.get(eventId);
    if (e) {
      e.status = 'cancelled';
      this.touch(eventId);
    }
  }

  moveEventExternally(eventId: string, start: Date, end: Date) {
    const e = this.events.get(eventId);
    if (e) {
      e.start = { ...e.start, dateTime: start.toISOString() };
      e.end = { ...e.end, dateTime: end.toISOString() };
      this.touch(eventId);
    }
  }

  liveEvents() {
    return [...this.events.values()].filter((e) => e.status === 'confirmed');
  }

  private touch(eventId: string) {
    this.changeLog.push({ seq: ++this.seq, eventId });
  }

  private issueAccessToken() {
    const t = `g-at-${++this.counter}`;
    this.accessTokens.add(t);
    return t;
  }

  handle(method: string, url: URL, body: unknown, headers: Record<string, string>): Response {
    const form = (body ?? {}) as Record<string, string>;

    if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token') {
      if (form.client_id !== process.env.GOOGLE_CLIENT_ID || form.client_secret !== process.env.GOOGLE_CLIENT_SECRET) {
        return json(401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' });
      }
      if (form.grant_type === 'authorization_code') {
        const grant = this.codes.get(form.code);
        this.codes.delete(form.code);
        if (!grant) return json(400, { error: 'invalid_grant', error_description: 'Malformed auth code.' });
        if (grant.redirectUri !== form.redirect_uri) return json(400, { error: 'redirect_uri_mismatch' });
        if (s256(form.code_verifier ?? '') !== grant.challenge) {
          return json(400, { error: 'invalid_grant', error_description: 'Invalid code verifier.' });
        }
        const refresh = `g-rt-${++this.counter}`;
        this.refreshTokens.add(refresh);
        return json(200, { access_token: this.issueAccessToken(), expires_in: 3599, refresh_token: refresh, scope: grant.scopes.join(' '), token_type: 'Bearer' });
      }
      if (form.grant_type === 'refresh_token') {
        if (!this.refreshTokens.has(form.refresh_token)) {
          return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        }
        // Google does not rotate refresh tokens.
        return json(200, { access_token: this.issueAccessToken(), expires_in: 3599, scope: GOOGLE_FULL_SCOPES.join(' '), token_type: 'Bearer' });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }

    if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/revoke') {
      this.revoked.push(form.token);
      this.refreshTokens.delete(form.token);
      this.accessTokens.delete(form.token);
      return json(200, {});
    }

    const token = bearer(headers);
    if (!token || !this.accessTokens.has(token)) {
      return json(401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } });
    }

    if (url.origin === 'https://openidconnect.googleapis.com' && url.pathname === '/v1/userinfo') {
      return json(200, { ...this.account, email_verified: true });
    }

    const path = url.pathname.replace(/^\/calendar\/v3/, '');
    if (path === '/users/me/calendarList' && method === 'GET') {
      return json(200, { kind: 'calendar#calendarList', items: this.calendars });
    }

    if (path === '/freeBusy' && method === 'POST') {
      const b = body as { timeMin: string; timeMax: string; items: { id: string }[] };
      const min = Date.parse(b.timeMin);
      const max = Date.parse(b.timeMax);
      const calendars: Record<string, unknown> = {};
      for (const { id } of b.items) {
        const error = this.freeBusyErrors.get(id);
        if (error) {
          calendars[id] = { errors: [{ domain: 'global', reason: error }], busy: [] };
          continue;
        }
        calendars[id] = { busy: (this.busy.get(id) ?? []).filter((x) => Date.parse(x.start) < max && Date.parse(x.end) > min) };
      }
      return json(200, { kind: 'calendar#freeBusy', timeMin: b.timeMin, timeMax: b.timeMax, calendars });
    }

    if (path === '/channels/stop' && method === 'POST') {
      this.channels.delete((body as { id: string }).id);
      return noContent();
    }

    const eventsMatch = /^\/calendars\/([^/]+)\/events(?:\/(watch|[^/]+))?$/.exec(path);
    if (eventsMatch) {
      const calendarId = decodeURIComponent(eventsMatch[1]);
      const sub = eventsMatch[2] ? decodeURIComponent(eventsMatch[2]) : null;

      if (sub === 'watch' && method === 'POST') {
        const b = body as { id: string; token: string; address: string; params?: { ttl?: string } };
        const resourceId = `resource-${calendarId}`;
        this.channels.set(b.id, { calendarId, token: b.token, address: b.address, resourceId });
        const ttl = Number(b.params?.ttl ?? 604800);
        return json(200, { kind: 'api#channel', id: b.id, resourceId, expiration: String(Date.now() + ttl * 1000) });
      }

      if (!sub && method === 'GET') {
        const syncToken = url.searchParams.get('syncToken');
        let items: FakeGoogleEvent[];
        if (syncToken) {
          const since = Number(syncToken.replace('sync-', ''));
          const ids = new Set(this.changeLog.filter((c) => c.seq > since).map((c) => c.eventId));
          items = [...ids].map((id) => this.events.get(id)!).filter((e) => e && e.calendarId === calendarId);
        } else {
          if (this.eventsForbidden.has(calendarId)) return json(403, { error: { code: 403, message: 'Forbidden', errors: [{ reason: 'forbidden' }] } });
          items = [...this.events.values()].filter((e) => e.calendarId === calendarId);
          const timeMax = url.searchParams.get('timeMax');
          if (timeMax) {
            // Range listing (singleEvents=true): events overlapping [timeMin, timeMax).
            const min = Date.parse(url.searchParams.get('timeMin')!);
            const max = Date.parse(timeMax);
            items = items.filter((e) => Date.parse(e.start.dateTime ?? e.start.date!) < max && Date.parse(e.end.dateTime ?? e.end.date!) > min);
          }
        }
        return json(200, { kind: 'calendar#events', items: items.map(publicEvent), nextSyncToken: `sync-${this.seq}` });
      }

      if (!sub && method === 'POST') {
        const b = body as Omit<FakeGoogleEvent, 'calendarId' | 'status'> & { id?: string };
        const id = b.id ?? `evt${++this.counter}`;
        if (this.events.has(id)) {
          return json(409, { error: { code: 409, message: 'The requested identifier already exists.', errors: [{ reason: 'duplicate' }] } });
        }
        const event: FakeGoogleEvent = { ...b, id, calendarId, status: 'confirmed', sendUpdates: url.searchParams.get('sendUpdates') };
        this.events.set(id, event);
        this.touch(id);
        return json(200, publicEvent(event));
      }

      if (sub && method === 'PATCH') {
        const existing = this.events.get(sub);
        if (!existing || existing.calendarId !== calendarId) return json(404, { error: { code: 404, message: 'Not Found' } });
        const b = body as Partial<FakeGoogleEvent>;
        Object.assign(existing, b, { status: b.status ?? existing.status, sendUpdates: url.searchParams.get('sendUpdates') });
        this.touch(sub);
        return json(200, publicEvent(existing));
      }

      if (sub && method === 'DELETE') {
        const existing = this.events.get(sub);
        if (!existing || existing.status === 'cancelled') return json(410, { error: { code: 410, message: 'Resource has been deleted' } });
        existing.status = 'cancelled';
        existing.sendUpdates = url.searchParams.get('sendUpdates');
        this.touch(sub);
        return noContent();
      }
    }

    return json(404, { error: { code: 404, message: `Fake Google has no route for ${method} ${url.pathname}` } });
  }
}

function publicEvent(e: FakeGoogleEvent) {
  return {
    kind: 'calendar#event',
    id: e.id,
    status: e.status,
    htmlLink: `https://www.google.com/calendar/event?eid=${e.id}`,
    summary: e.summary,
    description: e.description,
    location: e.location,
    start: e.start,
    end: e.end,
    transparency: e.transparency,
    hangoutLink: e.hangoutLink,
    organizer: e.organizer,
    attendees: e.attendees,
    extendedProperties: e.extendedProperties,
  };
}

// ---------------------------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------------------------

export interface FakeZoomMeeting {
  id: number;
  topic: string;
  type: number;
  start_time: string;
  duration: number;
  timezone: string;
  agenda: string;
  settings: Record<string, unknown>;
  join_url: string;
  start_url: string;
  password: string;
}

/** Granular scopes a correctly configured Zoom Marketplace app grants. */
export const ZOOM_FULL_SCOPES = ['user:read:user', 'meeting:write:meeting', 'meeting:update:meeting', 'meeting:delete:meeting', 'meeting:read:meeting'];

class FakeZoom {
  account = { id: 'KdYKjnimT4KPd8FFgQt9FQ', email: 'priya@zoom.test', first_name: 'Priya', last_name: 'Nair', display_name: 'Priya Nair' };
  meetings = new Map<string, FakeZoomMeeting>();
  deleted: string[] = [];
  revoked: string[] = [];

  private codes = new Map<string, { challenge: string; scopes: string[]; redirectUri: string }>();
  private accessTokens = new Set<string>();
  private refreshTokens = new Set<string>();
  private counter = 0;
  private nextMeetingId = 85_123_456_001;

  /** Consent to the app. Zoom grants whatever scopes the Marketplace app has, simulated by `opts.scopes`. */
  authorize(authorizationUrl: string, opts: { scopes?: string[] } = {}) {
    const url = new URL(authorizationUrl);
    const code = `z-code-${++this.counter}`;
    this.codes.set(code, {
      challenge: url.searchParams.get('code_challenge') ?? '',
      scopes: opts.scopes ?? ZOOM_FULL_SCOPES,
      redirectUri: url.searchParams.get('redirect_uri') ?? '',
    });
    return { code, state: url.searchParams.get('state') ?? '' };
  }

  expireAccessTokens() {
    this.accessTokens.clear();
  }

  revokeGrant() {
    this.accessTokens.clear();
    this.refreshTokens.clear();
  }

  deleteMeetingExternally(id: string) {
    this.meetings.delete(id);
  }

  private issue(scopes = ZOOM_FULL_SCOPES) {
    const access = `z-at-${++this.counter}`;
    const refresh = `z-rt-${++this.counter}`;
    this.accessTokens.add(access);
    this.refreshTokens.add(refresh);
    return { access_token: access, token_type: 'bearer', refresh_token: refresh, expires_in: 3599, scope: scopes.join(' ') };
  }

  handle(method: string, url: URL, body: unknown, headers: Record<string, string>): Response {
    const form = (body ?? {}) as Record<string, string>;
    const expectedBasic = `Basic ${Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString('base64')}`;

    if (url.origin === 'https://zoom.us' && url.pathname === '/oauth/token') {
      if (headers.authorization !== expectedBasic) return json(401, { reason: 'Invalid client_id or client_secret', error: 'invalid_client' });
      if (form.grant_type === 'authorization_code') {
        const grant = this.codes.get(form.code);
        this.codes.delete(form.code);
        if (!grant || grant.redirectUri !== form.redirect_uri) return json(400, { reason: 'Invalid authorization code', error: 'invalid_request' });
        if (s256(form.code_verifier ?? '') !== grant.challenge) return json(400, { reason: 'Invalid code verifier', error: 'invalid_grant' });
        return json(200, this.issue(grant.scopes));
      }
      if (form.grant_type === 'refresh_token') {
        // Zoom rotates refresh tokens: the old one stops working immediately.
        if (!this.refreshTokens.delete(form.refresh_token)) return json(400, { reason: 'Invalid Token!', error: 'invalid_grant' });
        return json(200, this.issue());
      }
      return json(400, { reason: 'Unsupported grant type', error: 'unsupported_grant_type' });
    }

    if (url.origin === 'https://zoom.us' && url.pathname === '/oauth/revoke') {
      if (headers.authorization !== expectedBasic) return json(401, { reason: 'Invalid client_id or client_secret' });
      this.revoked.push(form.token);
      this.refreshTokens.delete(form.token);
      return json(200, { status: 'success' });
    }

    const token = bearer(headers);
    if (!token || !this.accessTokens.has(token)) return json(401, { code: 124, message: 'Invalid access token.' });

    const path = url.pathname.replace(/^\/v2/, '');
    if (path === '/users/me' && method === 'GET') return json(200, this.account);

    if (path === '/users/me/meetings' && method === 'POST') {
      const b = body as Omit<FakeZoomMeeting, 'id' | 'join_url' | 'start_url' | 'password'>;
      const id = this.nextMeetingId++;
      const meeting: FakeZoomMeeting = {
        ...b,
        id,
        join_url: `https://us06web.zoom.us/j/${id}?pwd=pwd${id}`,
        start_url: `https://us06web.zoom.us/s/${id}?zak=host-secret-${id}`,
        password: `pw${String(id).slice(-6)}`,
      };
      this.meetings.set(String(id), meeting);
      return json(201, meeting);
    }

    const meetingMatch = /^\/meetings\/(\d+)$/.exec(path);
    if (meetingMatch) {
      const id = meetingMatch[1];
      const meeting = this.meetings.get(id);
      if (!meeting) return json(404, { code: 3001, message: `Meeting does not exist: ${id}.` });
      if (method === 'GET') return json(200, { ...meeting, start_url: `https://us06web.zoom.us/s/${id}?zak=fresh-${++this.counter}` });
      if (method === 'PATCH') {
        Object.assign(meeting, body as Partial<FakeZoomMeeting>);
        return noContent();
      }
      if (method === 'DELETE') {
        this.meetings.delete(id);
        this.deleted.push(id);
        return noContent();
      }
    }

    return json(404, { code: 404, message: `Fake Zoom has no route for ${method} ${url.pathname}` });
  }
}

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------

class FakeProviders {
  google = new FakeGoogle();
  zoom = new FakeZoom();
  calls: RecordedCall[] = [];
  private failures: InjectedFailure[] = [];

  reset() {
    this.google = new FakeGoogle();
    this.zoom = new FakeZoom();
    this.calls = [];
    this.failures = [];
  }

  /** Makes the next `times` matching requests fail with the given HTTP response (or a network error). */
  failNext(f: Omit<InjectedFailure, 'times'> & { times?: number }) {
    this.failures.push({ times: 1, ...f });
  }

  clearFailures() {
    this.failures = [];
  }

  callsTo(provider: ProviderName, method: string, path: RegExp) {
    return this.calls.filter((c) => c.provider === provider && c.method === method && path.test(c.path));
  }

  fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = normaliseHeaders(init);
    const body = parseBody(init);
    const provider: ProviderName | null = /(^|\.)google(apis)?\.com$/.test(url.hostname)
      ? 'google'
      : /(^|\.)zoom\.us$/.test(url.hostname)
        ? 'zoom'
        : null;
    if (!provider) throw new TypeError(`fetch failed: unexpected outbound request to ${url.origin} in tests`);
    this.calls.push({ provider, method, url, path: url.pathname, body, headers });

    const failure = this.failures.find(
      (f) => f.times > 0 && f.provider === provider && (!f.method || f.method === method) && f.path.test(url.pathname),
    );
    if (failure) {
      failure.times--;
      if (failure.networkError) throw new TypeError('fetch failed: ECONNRESET (simulated)');
      return json(failure.status ?? 500, failure.body ?? { error: { code: failure.status ?? 500, message: 'Simulated provider failure' } }, failure.headers);
    }
    return provider === 'google' ? this.google.handle(method, url, body, headers) : this.zoom.handle(method, url, body, headers);
  };
}

export const fakeProviders = new FakeProviders();
