import { describe, expect, it } from 'vitest';
import { buildIcs, escapeText } from '@/server/notifications/ics';
import { reminderOffsetsFor } from '@/server/notifications/planner';
import { escapeHtml, fillTemplate, renderEmail, type EmailContext } from '@/server/notifications/templates';

describe('iCalendar invitations', () => {
  const base = {
    uid: 'interview-123@slate',
    sequence: 2,
    method: 'REQUEST' as const,
    start: new Date('2026-03-08T14:00:00Z'),
    end: new Date('2026-03-08T15:00:00Z'),
    summary: 'Technical Interview with Priya Nair',
    description: 'Line one\nJoin: https://zoom.us/j/1',
    location: 'Room 4; Floor 2, Building A',
    url: 'https://app.test/booking/abc',
    organizer: { name: 'Priya "PN" Nair', email: 'priya@northwind.test' },
    attendee: { name: 'Riley Carter', email: 'riley@candidate.test' },
    status: 'CONFIRMED' as const,
  };

  it('escapes TEXT values per RFC 5545 (backslash, semicolon, comma, newline)', () => {
    expect(escapeText('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne');
  });

  it('produces a UTC, versioned VEVENT that calendar clients can update in place', () => {
    const ics = buildIcs(base);
    const lines = ics.split('\r\n');
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(lines).toContain('METHOD:REQUEST');
    expect(lines).toContain('UID:interview-123@slate');
    expect(lines).toContain('SEQUENCE:2');
    expect(lines).toContain('DTSTART:20260308T140000Z');
    expect(lines).toContain('DTEND:20260308T150000Z');
    expect(lines).toContain('LOCATION:Room 4\\; Floor 2\\, Building A');
    expect(lines).toContain('DESCRIPTION:Line one\\nJoin: https://zoom.us/j/1');
    expect(ics).toContain('ORGANIZER;CN="Priya PN Nair":mailto:priya@northwind.test');
    expect(lines).toContain('BEGIN:VALARM');
  });

  it('folds long lines at 75 octets without splitting multi-byte characters', () => {
    const ics = buildIcs({ ...base, description: 'Résumé review — '.repeat(20) });
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain(`DESCRIPTION:${'Résumé review — '.repeat(20)}`);
  });

  it('marks cancellations so clients remove the event', () => {
    const ics = buildIcs({ ...base, method: 'CANCEL', status: 'CANCELLED', sequence: 3 });
    expect(ics).toContain('METHOD:CANCEL');
    expect(ics).toContain('STATUS:CANCELLED');
    expect(ics).not.toContain('BEGIN:VALARM');
  });
});

describe('email templates', () => {
  const ctx = (over: Partial<EmailContext> = {}): EmailContext => ({
    type: 'booking_confirmation',
    recipient: { name: 'Riley Carter', email: 'riley@candidate.test', kind: 'candidate', timezone: 'Europe/London' },
    organization: { name: 'Northwind Labs', brandColor: '#0e7c66', logoUrl: null },
    eventType: { name: 'Technical Interview', durationMinutes: 60 },
    host: { name: 'Priya Nair', email: 'priya@northwind.test', title: 'Staff Engineer' },
    candidate: { name: 'Riley Carter', email: 'riley@candidate.test', phone: null, linkedinUrl: null, resumeUrl: null, company: null },
    interview: {
      id: 'i1',
      // 14:00 UTC on the day US clocks change (UK has not changed yet) → 14:00 in London.
      start: new Date('2026-03-08T14:00:00Z'),
      end: new Date('2026-03-08T15:00:00Z'),
      locationType: 'zoom',
      locationDetails: null,
      responses: [],
      cancelReason: null,
    },
    meeting: { joinUrl: 'https://zoom.us/j/123?pwd=x', passcode: '998877', pending: false },
    links: {
      view: 'https://app.test/booking/v',
      reschedule: 'https://app.test/booking/reschedule/r',
      cancel: 'https://app.test/booking/cancel/c',
      dashboard: 'https://app.test/interviews/i1',
      googleCalendar: null,
      outlookCalendar: null,
      bookAgain: null,
    },
    metadata: {},
    ...over,
  });

  it('renders times in the recipient zone, with join, reschedule and cancel links', () => {
    const email = renderEmail(ctx());
    expect(email.subject).toBe('Confirmed: Technical Interview with Priya Nair — Sun, Mar 8');
    expect(email.text).toContain('2:00 PM – 3:00 PM');
    expect(email.text).toContain('Europe/London');
    expect(email.text).toContain('https://zoom.us/j/123?pwd=x');
    expect(email.text).toContain('Reschedule: https://app.test/booking/reschedule/r');
    expect(email.text).toContain('Cancel: https://app.test/booking/cancel/c');
    expect(email.html).toContain('Passcode: 998877');

    const ny = renderEmail(ctx({ recipient: { name: 'Priya', email: 'p@x.test', kind: 'host', timezone: 'America/New_York' }, type: 'host_booking_notification' }));
    // Same instant, New York already on daylight time: 10:00 AM EDT.
    expect(ny.text).toContain('10:00 AM – 11:00 AM');
  });

  it('escapes every user-controlled value in HTML', () => {
    const email = renderEmail(
      ctx({
        type: 'host_booking_notification',
        recipient: { name: 'Priya', email: 'p@x.test', kind: 'host', timezone: 'UTC' },
        candidate: { name: '<img src=x onerror=alert(1)>', email: 'x@candidate.test', phone: '"><script>1</script>', linkedinUrl: null, resumeUrl: null, company: null },
        interview: { ...ctx().interview, responses: [{ label: 'Why us?', answer: '<b>bold</b>' }] },
      }),
    );
    expect(email.html).not.toMatch(/<img src=x|<script>1<\/script>|<b>bold<\/b>/);
    expect(email.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  it('fills organisation placeholders and drops unknown ones', () => {
    expect(fillTemplate('Hi {{ candidate_first_name }} from {{organization_name}}{{nope}}!', { candidate_first_name: 'Riley', organization_name: 'Northwind' })).toBe(
      'Hi Riley from Northwind!',
    );
    const email = renderEmail(ctx({ override: { subject: '{{event_name}} on {{date}}', intro: null } }));
    expect(email.subject).toBe('Technical Interview on Sunday, March 8, 2026');
  });

  it('tells candidates when the Zoom link is still being created', () => {
    const email = renderEmail(ctx({ meeting: { joinUrl: null, passcode: null, pending: true } }));
    expect(email.text).toContain('Zoom (link to follow)');
    expect(email.html).toContain('the meeting link will be emailed to you separately');
  });
});

describe('reminder offsets', () => {
  it('prefers the event type, then the organisation, then the default', () => {
    expect(reminderOffsetsFor({ organization: { settings: {} }, eventType: { reminderOffsetsMinutes: null } })).toEqual([1440, 60]);
    expect(reminderOffsetsFor({ organization: { settings: { reminderOffsetsMinutes: [30, 2880] } }, eventType: { reminderOffsetsMinutes: null } })).toEqual([2880, 30]);
    expect(reminderOffsetsFor({ organization: { settings: { reminderOffsetsMinutes: [30] } }, eventType: { reminderOffsetsMinutes: [120, 120, 15] } })).toEqual([120, 15]);
  });

  it('ignores invalid offsets', () => {
    expect(reminderOffsetsFor({ organization: { settings: {} }, eventType: { reminderOffsetsMinutes: [0, -5, 1.5, 60, 99_999] } })).toEqual([60]);
  });
});
