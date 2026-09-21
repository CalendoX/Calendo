/**
 * Minimal RFC 5545 iCalendar generator for interview invitations.
 * The UID is stable per interview and SEQUENCE follows the interview version, so calendar
 * clients update (or cancel) the same entry on reschedule/cancellation.
 */

export interface IcsEvent {
  uid: string;
  sequence: number;
  method: 'REQUEST' | 'CANCEL';
  start: Date;
  end: Date;
  summary: string;
  description: string;
  location?: string | null;
  url?: string | null;
  organizer: { name: string; email: string };
  attendee: { name: string; email: string };
  status: 'CONFIRMED' | 'CANCELLED';
  /**
   * Sent to the attendee themself: ask for a reply, so mail and calendar apps show
   * Yes / No / Maybe (the reply goes to the organizer).
   */
  rsvp?: boolean;
}

function attendeeStatus(e: IcsEvent) {
  if (e.method === 'CANCEL') return 'PARTSTAT=DECLINED;RSVP=FALSE';
  return e.rsvp ? 'PARTSTAT=NEEDS-ACTION;RSVP=TRUE' : 'PARTSTAT=ACCEPTED;RSVP=FALSE';
}

function formatUtc(date: Date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function escapeText(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Folds lines longer than 75 octets (continuation lines start with a space). */
function fold(line: string) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const ch of line) {
    const len = Buffer.byteLength(ch, 'utf8');
    const limit = parts.length === 0 ? 75 : 74;
    if (currentBytes + len > limit) {
      parts.push(current);
      current = '';
      currentBytes = 0;
    }
    current += ch;
    currentBytes += len;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

function cn(name: string) {
  return `"${name.replace(/["\r\n]/g, '')}"`;
}

export function buildIcs(e: IcsEvent): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Calendo//Interview Scheduling//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${e.method}`,
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `SEQUENCE:${e.sequence}`,
    `DTSTAMP:${formatUtc(new Date())}`,
    `DTSTART:${formatUtc(e.start)}`,
    `DTEND:${formatUtc(e.end)}`,
    `SUMMARY:${escapeText(e.summary)}`,
    `DESCRIPTION:${escapeText(e.description)}`,
    ...(e.location ? [`LOCATION:${escapeText(e.location)}`] : []),
    ...(e.url ? [`URL:${e.url}`] : []),
    `ORGANIZER;CN=${cn(e.organizer.name)}:mailto:${e.organizer.email}`,
    `ATTENDEE;CN=${cn(e.attendee.name)};ROLE=REQ-PARTICIPANT;${attendeeStatus(e)}:mailto:${e.attendee.email}`,
    `STATUS:${e.status}`,
    'TRANSP:OPAQUE',
    ...(e.method === 'REQUEST'
      ? ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Interview reminder', 'TRIGGER:-PT15M', 'END:VALARM']
      : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** "Add to Google Calendar" template link (no API access required). */
export function googleCalendarTemplateUrl(p: { title: string; start: Date; end: Date; details: string; location?: string | null }) {
  const url = new URL('https://calendar.google.com/calendar/render');
  url.searchParams.set('action', 'TEMPLATE');
  url.searchParams.set('text', p.title);
  url.searchParams.set('dates', `${formatUtc(p.start)}/${formatUtc(p.end)}`);
  url.searchParams.set('details', p.details);
  if (p.location) url.searchParams.set('location', p.location);
  return url.toString();
}

export function outlookCalendarUrl(p: { title: string; start: Date; end: Date; details: string; location?: string | null }) {
  const url = new URL('https://outlook.live.com/calendar/0/deeplink/compose');
  url.searchParams.set('subject', p.title);
  url.searchParams.set('startdt', p.start.toISOString());
  url.searchParams.set('enddt', p.end.toISOString());
  url.searchParams.set('body', p.details);
  if (p.location) url.searchParams.set('location', p.location);
  url.searchParams.set('path', '/calendar/action/compose');
  url.searchParams.set('rru', 'addevent');
  return url.toString();
}
