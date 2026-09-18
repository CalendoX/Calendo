import type { IntegrationProvider } from '../db/schema';
import type { TimeRange } from '../scheduling/engine';

/**
 * Provider abstractions. The scheduling system only depends on these interfaces, so adding
 * Microsoft Outlook (a CalendarProvider) or Google Meet / Microsoft Teams (a
 * ConferencingProvider) means implementing an interface and registering it — the booking,
 * sync and notification code does not change.
 */

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
}

export interface ExternalAccount {
  id: string;
  email: string | null;
  name: string | null;
}

/** Supplies a valid access token; `refresh()` forces a refresh after a 401. */
export interface AccessTokenSource {
  get(): Promise<string>;
  refresh(): Promise<string>;
}

export interface OAuthAdapter {
  readonly provider: IntegrationProvider;
  readonly displayName: string;
  isConfigured(): boolean;
  buildAuthorizationUrl(params: { state: string; codeChallenge: string }): string;
  exchangeCode(code: string, codeVerifier: string): Promise<OAuthTokens>;
  refreshTokens(refreshToken: string): Promise<OAuthTokens>;
  fetchAccount(accessToken: string): Promise<ExternalAccount>;
  revoke(token: string): Promise<void>;
}

export interface ExternalCalendar {
  id: string;
  name: string;
  timezone: string | null;
  isPrimary: boolean;
  accessRole: string | null;
  color: string | null;
}

export interface CalendarEventInput {
  /** Stable identifier of the internal interview (used for idempotent creation). */
  interviewId: string;
  title: string;
  description: string;
  location: string | null;
  start: Date;
  end: Date;
  timezone: string;
  attendees: { email: string; name?: string }[];
  /** Whether the provider should email attendees about this change. */
  notifyAttendees: boolean;
  sourceUrl: string | null;
}

export interface CalendarEventResult {
  externalEventId: string;
  htmlLink: string | null;
}

export interface CalendarProvider {
  readonly provider: IntegrationProvider;
  listCalendars(token: AccessTokenSource): Promise<ExternalCalendar[]>;
  getBusy(token: AccessTokenSource, params: { calendarIds: string[]; start: Date; end: Date }): Promise<TimeRange[]>;
  createEvent(token: AccessTokenSource, calendarId: string, input: CalendarEventInput): Promise<CalendarEventResult>;
  updateEvent(
    token: AccessTokenSource,
    calendarId: string,
    externalEventId: string,
    input: CalendarEventInput,
  ): Promise<CalendarEventResult>;
  cancelEvent(token: AccessTokenSource, calendarId: string, externalEventId: string, notifyAttendees: boolean): Promise<void>;
}

export interface MeetingInput {
  interviewId: string;
  topic: string;
  agenda: string;
  start: Date;
  durationMinutes: number;
  timezone: string;
  invitees: { email: string; name?: string }[];
}

export interface MeetingResult {
  externalMeetingId: string;
  joinUrl: string;
  hostUrl: string | null;
  passcode: string | null;
}

export interface ConferencingProvider {
  readonly provider: IntegrationProvider;
  createMeeting(token: AccessTokenSource, input: MeetingInput): Promise<MeetingResult>;
  /** Returns updated meeting details (some providers return nothing; then the previous details stand). */
  updateMeeting(token: AccessTokenSource, externalMeetingId: string, input: MeetingInput): Promise<Partial<MeetingResult>>;
  cancelMeeting(token: AccessTokenSource, externalMeetingId: string): Promise<void>;
  /** Fresh host/start URL (Zoom start URLs expire after a few hours). */
  getHostUrl(token: AccessTokenSource, externalMeetingId: string): Promise<string | null>;
}

export type IntegrationErrorKind =
  /** Credentials invalid/revoked — the user must reconnect. Not retryable. */
  | 'auth'
  /** The remote object no longer exists. */
  | 'not_found'
  /** Provider asked us to slow down. Retryable. */
  | 'rate_limited'
  /** Network failure / 5xx / timeout. Retryable. */
  | 'transient'
  /** Rejected request (4xx) — retrying will not help. */
  | 'permanent'
  /** No active connection for this provider. */
  | 'not_connected'
  /** Conflict (e.g. the client-specified id already exists). */
  | 'conflict';

export class IntegrationError extends Error {
  constructor(
    public readonly provider: IntegrationProvider,
    public readonly kind: IntegrationErrorKind,
    message: string,
    public readonly status?: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'IntegrationError';
  }

  get retryable() {
    return this.kind === 'transient' || this.kind === 'rate_limited';
  }
}

export function isIntegrationError(err: unknown): err is IntegrationError {
  return err instanceof IntegrationError;
}
