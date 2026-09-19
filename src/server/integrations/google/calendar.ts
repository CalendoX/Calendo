import { DateTime } from 'luxon';
import { authedRequest } from '../http';
import {
  IntegrationError,
  type AccessTokenSource,
  type CalendarEventInput,
  type CalendarEventResult,
  type CalendarProvider,
  type ExternalCalendar,
} from '../types';
import type { TimeRange } from '../../scheduling/engine';

export const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

interface GoogleCalendarListResponse {
  items?: {
    id: string;
    summary?: string;
    summaryOverride?: string;
    primary?: boolean;
    timeZone?: string;
    accessRole?: string;
    backgroundColor?: string;
    deleted?: boolean;
    hidden?: boolean;
  }[];
  nextPageToken?: string;
}

interface GoogleFreeBusyResponse {
  calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: { domain: string; reason: string }[] }>;
}

interface GoogleEvent {
  id: string;
  htmlLink?: string;
  status?: string;
  iCalUID?: string;
}

const enc = encodeURIComponent;

/**
 * Deterministic, Google-valid event id (base32hex alphabet a–v, 0–9) derived from the interview id.
 * Supplying our own id makes creation idempotent: a retried insert returns 409 instead of
 * creating a duplicate event.
 */
export function googleEventIdFor(interviewId: string): string {
  return `slate${interviewId.replace(/-/g, '').toLowerCase()}`;
}

function eventBody(input: CalendarEventInput) {
  return {
    summary: input.title,
    description: input.description,
    location: input.location ?? undefined,
    start: { dateTime: input.start.toISOString(), timeZone: input.timezone },
    end: { dateTime: input.end.toISOString(), timeZone: input.timezone },
    attendees: input.attendees.map((a) => ({ email: a.email, displayName: a.name })),
    status: 'confirmed',
    transparency: 'opaque',
    reminders: { useDefault: true },
    guestsCanModify: false,
    guestsCanInviteOthers: false,
    extendedProperties: { private: { slateInterviewId: input.interviewId } },
    source: input.sourceUrl ? { title: 'Calendor interview', url: input.sourceUrl } : undefined,
  };
}

export const googleCalendarProvider: CalendarProvider = {
  provider: 'google_calendar',

  async listCalendars(token: AccessTokenSource): Promise<ExternalCalendar[]> {
    const out: ExternalCalendar[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const url = new URL(`${GOOGLE_CALENDAR_API}/users/me/calendarList`);
      url.searchParams.set('minAccessRole', 'freeBusyReader');
      url.searchParams.set('maxResults', '250');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const { data } = await authedRequest<GoogleCalendarListResponse>('google_calendar', token, { url: url.toString() }, 'List Google calendars');
      for (const c of data.items ?? []) {
        if (c.deleted) continue;
        out.push({
          id: c.id,
          name: c.summaryOverride ?? c.summary ?? c.id,
          timezone: c.timeZone ?? null,
          isPrimary: Boolean(c.primary),
          accessRole: c.accessRole ?? null,
          color: c.backgroundColor ?? null,
        });
      }
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  },

  async getBusy(token, { calendarIds, start, end }): Promise<TimeRange[]> {
    if (calendarIds.length === 0) return [];
    const { data } = await authedRequest<GoogleFreeBusyResponse>(
      'google_calendar',
      token,
      {
        method: 'POST',
        url: `${GOOGLE_CALENDAR_API}/freeBusy`,
        body: { timeMin: start.toISOString(), timeMax: end.toISOString(), items: calendarIds.map((id) => ({ id })) },
      },
      'Google free/busy query',
    );
    const busy: TimeRange[] = [];
    for (const id of calendarIds) {
      const cal = data.calendars?.[id];
      if (!cal) {
        throw new IntegrationError('google_calendar', 'transient', `Google free/busy returned no data for calendar ${id}`);
      }
      if (cal.errors?.length) {
        // Never treat an unreadable calendar as "free" — fail closed.
        const reasons = cal.errors.map((e) => e.reason).join(', ');
        const kind = cal.errors.every((e) => e.reason === 'notFound') ? 'permanent' : 'transient';
        throw new IntegrationError('google_calendar', kind, `Google free/busy error for calendar ${id}: ${reasons}`);
      }
      for (const b of cal.busy ?? []) {
        busy.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
      }
    }
    return busy;
  },

  async createEvent(token, calendarId, input): Promise<CalendarEventResult> {
    const id = googleEventIdFor(input.interviewId);
    const sendUpdates = input.notifyAttendees ? 'all' : 'none';
    try {
      const { data } = await authedRequest<GoogleEvent>(
        'google_calendar',
        token,
        {
          method: 'POST',
          url: `${GOOGLE_CALENDAR_API}/calendars/${enc(calendarId)}/events?sendUpdates=${sendUpdates}`,
          body: { id, ...eventBody(input) },
        },
        'Create Google Calendar event',
      );
      return { externalEventId: data.id, htmlLink: data.htmlLink ?? null };
    } catch (err) {
      // Already created by an earlier attempt (or previously cancelled): update it in place.
      if (err instanceof IntegrationError && err.kind === 'conflict') {
        return googleCalendarProvider.updateEvent(token, calendarId, id, input);
      }
      throw err;
    }
  },

  async updateEvent(token, calendarId, externalEventId, input): Promise<CalendarEventResult> {
    const sendUpdates = input.notifyAttendees ? 'all' : 'none';
    const { data } = await authedRequest<GoogleEvent>(
      'google_calendar',
      token,
      {
        method: 'PATCH',
        url: `${GOOGLE_CALENDAR_API}/calendars/${enc(calendarId)}/events/${enc(externalEventId)}?sendUpdates=${sendUpdates}`,
        body: eventBody(input),
      },
      'Update Google Calendar event',
    );
    return { externalEventId: data.id, htmlLink: data.htmlLink ?? null };
  },

  async cancelEvent(token, calendarId, externalEventId, notifyAttendees): Promise<void> {
    try {
      await authedRequest<unknown>(
        'google_calendar',
        token,
        {
          method: 'DELETE',
          url: `${GOOGLE_CALENDAR_API}/calendars/${enc(calendarId)}/events/${enc(externalEventId)}?sendUpdates=${notifyAttendees ? 'all' : 'none'}`,
        },
        'Delete Google Calendar event',
      );
    } catch (err) {
      // 404/410: already deleted — the desired end state is reached.
      if (err instanceof IntegrationError && err.kind === 'not_found') return;
      throw err;
    }
  },
};

// ------------------------------------------------------------------------------------------
// Push notifications (events.watch) and incremental sync
// ------------------------------------------------------------------------------------------

export interface WatchResult {
  resourceId: string;
  expiration: Date;
}

export async function watchCalendarEvents(
  token: AccessTokenSource,
  calendarId: string,
  params: { channelId: string; address: string; channelToken: string; ttlSeconds: number },
): Promise<WatchResult> {
  const { data } = await authedRequest<{ resourceId: string; expiration?: string }>(
    'google_calendar',
    token,
    {
      method: 'POST',
      url: `${GOOGLE_CALENDAR_API}/calendars/${enc(calendarId)}/events/watch`,
      body: {
        id: params.channelId,
        type: 'web_hook',
        address: params.address,
        token: params.channelToken,
        params: { ttl: String(params.ttlSeconds) },
      },
    },
    'Watch Google Calendar',
  );
  return {
    resourceId: data.resourceId,
    expiration: data.expiration ? new Date(Number(data.expiration)) : new Date(Date.now() + params.ttlSeconds * 1000),
  };
}

export async function stopWatchChannel(token: AccessTokenSource, channelId: string, resourceId: string) {
  try {
    await authedRequest<unknown>(
      'google_calendar',
      token,
      { method: 'POST', url: `${GOOGLE_CALENDAR_API}/channels/stop`, body: { id: channelId, resourceId } },
      'Stop Google watch channel',
    );
  } catch (err) {
    if (err instanceof IntegrationError && err.kind === 'not_found') return;
    throw err;
  }
}

export interface ChangedEvent {
  id: string;
  status: string;
  start: Date | null;
  end: Date | null;
  interviewId: string | null;
}

interface GoogleEventsListResponse {
  items?: {
    id: string;
    status?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
    extendedProperties?: { private?: Record<string, string> };
  }[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

/**
 * Incremental change feed. With no sync token, performs an initial listing (from now) purely to
 * obtain one. Returns `{ reset: true }` when Google invalidates the token (410) so the caller can
 * restart from scratch.
 */
export async function listChangedEvents(
  token: AccessTokenSource,
  calendarId: string,
  syncToken: string | null,
): Promise<{ events: ChangedEvent[]; nextSyncToken: string | null; reset: boolean }> {
  const events: ChangedEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;
  try {
    for (let page = 0; page < 20; page++) {
      const url = new URL(`${GOOGLE_CALENDAR_API}/calendars/${enc(calendarId)}/events`);
      url.searchParams.set('maxResults', '250');
      url.searchParams.set('showDeleted', 'true');
      if (syncToken) url.searchParams.set('syncToken', syncToken);
      else url.searchParams.set('timeMin', new Date().toISOString());
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const { data } = await authedRequest<GoogleEventsListResponse>('google_calendar', token, { url: url.toString() }, 'List Google Calendar changes');
      for (const e of data.items ?? []) {
        events.push({
          id: e.id,
          status: e.status ?? 'confirmed',
          start: e.start?.dateTime ? new Date(e.start.dateTime) : null,
          end: e.end?.dateTime ? new Date(e.end.dateTime) : null,
          interviewId: e.extendedProperties?.private?.slateInterviewId ?? null,
        });
      }
      pageToken = data.nextPageToken;
      if (data.nextSyncToken) nextSyncToken = data.nextSyncToken;
      if (!pageToken) break;
    }
  } catch (err) {
    if (err instanceof IntegrationError && err.kind === 'not_found' && err.status === 410) {
      return { events: [], nextSyncToken: null, reset: true };
    }
    throw err;
  }
  return { events, nextSyncToken, reset: false };
}

/** An event on the user's own Google calendar, with the details shown in Calendor's calendar view. */
export interface ExternalEventDetails {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location: string | null;
  videoUrl: string | null;
  htmlLink: string | null;
  organizer: { email: string; name: string | null } | null;
  attendees: { email: string; name: string | null; responseStatus: string | null; organizer: boolean }[];
}

interface GoogleEventDetailsResponse {
  items?: {
    id: string;
    status?: string;
    summary?: string;
    location?: string;
    htmlLink?: string;
    hangoutLink?: string;
    transparency?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
    organizer?: { email?: string; displayName?: string };
    attendees?: { email?: string; displayName?: string; responseStatus?: string; organizer?: boolean; resource?: boolean; self?: boolean }[];
    conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
    extendedProperties?: { private?: Record<string, string> };
  }[];
  nextPageToken?: string;
}

/** Links from event data (which any organiser controls) are only kept if they're plain http(s). */
const httpUrl = (u: string | undefined) => (u && /^https?:\/\//i.test(u) ? u : null);

const EVENT_FIELDS =
  'items(id,status,summary,location,htmlLink,hangoutLink,transparency,start,end,organizer(email,displayName),' +
  'attendees(email,displayName,responseStatus,organizer,resource,self),conferenceData(entryPoints(entryPointType,uri)),extendedProperties),nextPageToken';

/**
 * Events that make the user busy between `start` and `end` on one calendar (recurring events
 * expanded), with titles and guests. Mirrors free/busy: skips cancelled, "free" and declined
 * events. Also skips Calendor's own interview events, which the calendar view shows already.
 * All-day events (dates, not instants) are placed in `zone`.
 */
export async function listEventsInRange(token: AccessTokenSource, calendarId: string, range: { start: Date; end: Date }, zone: string): Promise<ExternalEventDetails[]> {
  const out: ExternalEventDetails[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 4; page++) {
    const url = new URL(`${GOOGLE_CALENDAR_API}/calendars/${enc(calendarId)}/events`);
    url.searchParams.set('timeMin', range.start.toISOString());
    url.searchParams.set('timeMax', range.end.toISOString());
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '250');
    url.searchParams.set('fields', EVENT_FIELDS);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const { data } = await authedRequest<GoogleEventDetailsResponse>('google_calendar', token, { url: url.toString() }, 'List Google Calendar events');
    for (const e of data.items ?? []) {
      if (e.status === 'cancelled' || e.transparency === 'transparent') continue;
      if (e.extendedProperties?.private?.slateInterviewId || e.id.startsWith('slate')) continue;
      if (e.attendees?.some((a) => a.self && a.responseStatus === 'declined')) continue;
      const allDay = !e.start?.dateTime;
      const start = e.start?.dateTime ? new Date(e.start.dateTime) : e.start?.date ? DateTime.fromISO(e.start.date, { zone }).toJSDate() : null;
      const end = e.end?.dateTime ? new Date(e.end.dateTime) : e.end?.date ? DateTime.fromISO(e.end.date, { zone }).toJSDate() : null;
      if (!start || !end) continue;
      out.push({
        id: e.id,
        title: e.summary?.trim() || '(No title)',
        start,
        end,
        allDay,
        location: e.location ?? null,
        videoUrl: httpUrl(e.hangoutLink) ?? httpUrl(e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri),
        htmlLink: httpUrl(e.htmlLink),
        organizer: e.organizer?.email ? { email: e.organizer.email, name: e.organizer.displayName ?? null } : null,
        attendees: (e.attendees ?? [])
          .filter((a) => a.email && !a.resource)
          .slice(0, 100)
          .map((a) => ({ email: a.email!, name: a.displayName ?? null, responseStatus: a.responseStatus ?? null, organizer: Boolean(a.organizer) })),
      });
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}
