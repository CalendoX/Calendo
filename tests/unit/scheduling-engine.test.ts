import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  checkSlot,
  computeAvailableSlots,
  localMinuteToInstant,
  type AvailabilityPolicy,
  type EventConstraints,
  type ExistingInterview,
} from '@/server/scheduling/engine';

const NY = 'America/New_York';
const LONDON = 'Europe/London';

const weekdays9to5 = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));

function policy(overrides: Partial<AvailabilityPolicy> = {}): AvailabilityPolicy {
  return { timezone: NY, weeklyRules: weekdays9to5, overrides: [], blockedDates: [], ...overrides };
}

function event(overrides: Partial<EventConstraints> = {}): EventConstraints {
  return {
    durationMinutes: 60,
    slotIntervalMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    maxDaysInFuture: null,
    dailyLimit: null,
    ...overrides,
  };
}

const at = (iso: string, zone = NY) => DateTime.fromISO(iso, { zone }).toMillis();
const fmt = (ms: number, zone = NY) => DateTime.fromMillis(ms, { zone }).toFormat('yyyy-LL-dd HH:mm');

function day(date: string, zone = NY) {
  const start = DateTime.fromISO(date, { zone });
  return { rangeStart: start.toMillis(), rangeEnd: start.plus({ days: 1 }).toMillis() };
}

// Monday 2026-10-05 is a normal (non-DST-transition) weekday.
const NOW = at('2026-10-01T08:00');

describe('computeAvailableSlots — working hours', () => {
  it('offers hourly slots inside 09:00–17:00 local time', () => {
    const slots = computeAvailableSlots(policy(), event(), {
      now: NOW,
      calendarBusy: [],
      interviews: [],
      ...day('2026-10-05'),
    });
    expect(slots.map((s) => fmt(s.start))).toEqual([
      '2026-10-05 09:00',
      '2026-10-05 10:00',
      '2026-10-05 11:00',
      '2026-10-05 12:00',
      '2026-10-05 13:00',
      '2026-10-05 14:00',
      '2026-10-05 15:00',
      '2026-10-05 16:00',
    ]);
    expect(slots.every((s) => s.end - s.start === 60 * 60_000)).toBe(true);
  });

  it('supports multiple intervals per day and disabled days', () => {
    const p = policy({
      weeklyRules: [
        { weekday: 1, startMinute: 9 * 60, endMinute: 12 * 60 },
        { weekday: 1, startMinute: 13 * 60, endMinute: 15 * 60 },
      ],
    });
    const monday = computeAvailableSlots(p, event(), { now: NOW, calendarBusy: [], interviews: [], ...day('2026-10-05') });
    expect(monday.map((s) => fmt(s.start).slice(11))).toEqual(['09:00', '10:00', '11:00', '13:00', '14:00']);
    const tuesday = computeAvailableSlots(p, event(), { now: NOW, calendarBusy: [], interviews: [], ...day('2026-10-06') });
    expect(tuesday).toEqual([]);
  });

  it('does not offer a slot that would run past the end of the window', () => {
    const slots = computeAvailableSlots(policy(), event({ durationMinutes: 90, slotIntervalMinutes: 30 }), {
      now: NOW,
      calendarBusy: [],
      interviews: [],
      ...day('2026-10-05'),
    });
    expect(fmt(slots[slots.length - 1].start).slice(11)).toBe('15:30');
  });

  it('applies date overrides (custom hours and full-day unavailability) and holidays', () => {
    const p = policy({
      overrides: [
        { date: '2026-10-05', startMinute: 14 * 60, endMinute: 16 * 60 },
        { date: '2026-10-06', startMinute: null, endMinute: null },
      ],
      blockedDates: ['2026-10-07'],
    });
    const ctx = { now: NOW, calendarBusy: [], interviews: [] };
    expect(computeAvailableSlots(p, event(), { ...ctx, ...day('2026-10-05') }).map((s) => fmt(s.start).slice(11))).toEqual([
      '14:00',
      '15:00',
    ]);
    expect(computeAvailableSlots(p, event(), { ...ctx, ...day('2026-10-06') })).toEqual([]);
    expect(computeAvailableSlots(p, event(), { ...ctx, ...day('2026-10-07') })).toEqual([]);
    expect(computeAvailableSlots(p, event(), { ...ctx, ...day('2026-10-08') })).toHaveLength(8);
  });
});

describe('computeAvailableSlots — notice and booking window', () => {
  it('enforces minimum scheduling notice', () => {
    const now = at('2026-10-05T10:30');
    const slots = computeAvailableSlots(policy(), event({ minimumNoticeMinutes: 120 }), {
      now,
      calendarBusy: [],
      interviews: [],
      ...day('2026-10-05'),
    });
    // 10:30 + 2h = 12:30 → first hourly slot is 13:00.
    expect(fmt(slots[0].start).slice(11)).toBe('13:00');
  });

  it('never offers slots in the past', () => {
    const now = at('2026-10-05T12:10');
    const slots = computeAvailableSlots(policy(), event(), { now, calendarBusy: [], interviews: [], ...day('2026-10-05') });
    expect(fmt(slots[0].start).slice(11)).toBe('13:00');
  });

  it('enforces the maximum scheduling range', () => {
    const now = at('2026-10-05T08:00');
    const range = { rangeStart: now, rangeEnd: at('2026-10-20T00:00') };
    const slots = computeAvailableSlots(policy(), event({ maxDaysInFuture: 3 }), {
      now,
      calendarBusy: [],
      interviews: [],
      ...range,
    });
    const dates = new Set(slots.map((s) => fmt(s.start).slice(0, 10)));
    expect([...dates]).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']);
  });
});

describe('computeAvailableSlots — conflicts and buffers', () => {
  it('excludes external calendar busy time (Google Calendar 10:00–11:00)', () => {
    const slots = computeAvailableSlots(policy(), event(), {
      now: NOW,
      calendarBusy: [{ start: at('2026-10-05T10:00'), end: at('2026-10-05T11:00') }],
      interviews: [],
      ...day('2026-10-05'),
    });
    const times = slots.map((s) => fmt(s.start).slice(11));
    expect(times).not.toContain('10:00');
    expect(times).toContain('09:00');
    expect(times).toContain('11:00');
  });

  it('excludes partially overlapping slots', () => {
    const slots = computeAvailableSlots(policy(), event({ slotIntervalMinutes: 30 }), {
      now: NOW,
      calendarBusy: [{ start: at('2026-10-05T10:15'), end: at('2026-10-05T10:45') }],
      interviews: [],
      ...day('2026-10-05'),
    });
    const times = slots.map((s) => fmt(s.start).slice(11));
    expect(times).not.toContain('09:30');
    expect(times).not.toContain('10:00');
    expect(times).not.toContain('10:30');
    expect(times).toContain('09:00');
    expect(times).toContain('11:00');
  });

  it('respects existing interviews and their after-buffer (10:00–11:00 + 15m → next start 11:15)', () => {
    const existing: ExistingInterview = {
      id: 'a',
      start: at('2026-10-05T10:00'),
      end: at('2026-10-05T11:00'),
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 15,
    };
    const slots = computeAvailableSlots(policy(), event({ slotIntervalMinutes: 15 }), {
      now: NOW,
      calendarBusy: [],
      interviews: [existing],
      ...day('2026-10-05'),
    });
    const times = slots.map((s) => fmt(s.start).slice(11));
    expect(times).not.toContain('11:00');
    expect(times).toContain('11:15');
    // A 60 minute slot at 09:00 ends exactly when the interview starts.
    expect(times).toContain('09:00');
    expect(times).not.toContain('09:15');
  });

  it("applies the new event's own before/after buffers", () => {
    const existing: ExistingInterview = {
      id: 'a',
      start: at('2026-10-05T12:00'),
      end: at('2026-10-05T13:00'),
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
    };
    const slots = computeAvailableSlots(
      policy(),
      event({ slotIntervalMinutes: 15, bufferBeforeMinutes: 30, bufferAfterMinutes: 15 }),
      { now: NOW, calendarBusy: [], interviews: [existing], ...day('2026-10-05') },
    );
    const times = slots.map((s) => fmt(s.start).slice(11));
    // After-buffer: slot must end by 11:45 → latest start before is 10:45.
    expect(times).toContain('10:45');
    expect(times).not.toContain('11:00');
    // Before-buffer: slot must start at least 30m after 13:00.
    expect(times).not.toContain('13:15');
    expect(times).toContain('13:30');
  });

  it('allows buffers to overlap each other but never a meeting', () => {
    const existing: ExistingInterview = {
      id: 'a',
      start: at('2026-10-05T10:00'),
      end: at('2026-10-05T11:00'),
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 15,
    };
    const slots = computeAvailableSlots(policy(), event({ slotIntervalMinutes: 15, bufferBeforeMinutes: 15 }), {
      now: NOW,
      calendarBusy: [],
      interviews: [existing],
      ...day('2026-10-05'),
    });
    expect(slots.map((s) => fmt(s.start).slice(11))).toContain('11:15');
  });

  it('ignores the interview being rescheduled', () => {
    const existing: ExistingInterview = {
      id: 'self',
      start: at('2026-10-05T10:00'),
      end: at('2026-10-05T11:00'),
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
    };
    const ctx = { now: NOW, calendarBusy: [], interviews: [existing], ...day('2026-10-05') };
    expect(computeAvailableSlots(policy(), event(), ctx).map((s) => fmt(s.start).slice(11))).not.toContain('10:00');
    expect(
      computeAvailableSlots(policy(), event(), { ...ctx, excludeInterviewId: 'self' }).map((s) => fmt(s.start).slice(11)),
    ).toContain('10:00');
  });

  it('enforces a daily interview limit', () => {
    const existing: ExistingInterview[] = [
      { id: 'a', start: at('2026-10-05T09:00'), end: at('2026-10-05T10:00'), bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
      { id: 'b', start: at('2026-10-05T13:00'), end: at('2026-10-05T14:00'), bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
    ];
    const ctx = { now: NOW, calendarBusy: [], interviews: existing };
    expect(computeAvailableSlots(policy(), event({ dailyLimit: 2 }), { ...ctx, ...day('2026-10-05') })).toEqual([]);
    expect(computeAvailableSlots(policy(), event({ dailyLimit: 2 }), { ...ctx, ...day('2026-10-06') })).toHaveLength(8);
  });
});

describe('time zones', () => {
  it('keeps the same instant while candidates view it in their own zone', () => {
    const slots = computeAvailableSlots(policy(), event(), { now: NOW, calendarBusy: [], interviews: [], ...day('2026-10-05') });
    // 09:00 New York (EDT, UTC−4) is 14:00 in London (BST, UTC+1).
    expect(fmt(slots[0].start, LONDON)).toBe('2026-10-05 14:00');
    expect(DateTime.fromMillis(slots[0].start).toUTC().toISO()).toBe('2026-10-05T13:00:00.000Z');
  });

  it('computes candidate-range queries that straddle the host day boundary', () => {
    // A Tokyo candidate asks for "their" Tuesday 6 Oct; New York Monday afternoon slots fall into it.
    const tokyoDay = DateTime.fromISO('2026-10-06', { zone: 'Asia/Tokyo' });
    const slots = computeAvailableSlots(policy(), event(), {
      now: NOW,
      calendarBusy: [],
      interviews: [],
      rangeStart: tokyoDay.toMillis(),
      rangeEnd: tokyoDay.plus({ days: 1 }).toMillis(),
    });
    const tokyoTimes = slots.map((s) => fmt(s.start, 'Asia/Tokyo'));
    expect(tokyoTimes[0]).toBe('2026-10-06 00:00'); // Mon 11:00 NY
    expect(tokyoTimes.every((t) => t.startsWith('2026-10-06'))).toBe(true);
  });
});

describe('daylight-saving transitions', () => {
  it('spring forward (US, 2026-03-08): working hours stay at 09:00 local, UTC offset changes', () => {
    const p = policy({ weeklyRules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })) });
    const now = at('2026-03-01T00:00');
    const sat = computeAvailableSlots(p, event(), { now, calendarBusy: [], interviews: [], ...day('2026-03-07') });
    const sun = computeAvailableSlots(p, event(), { now, calendarBusy: [], interviews: [], ...day('2026-03-08') });
    expect(DateTime.fromMillis(sat[0].start).toUTC().toFormat('HH:mm')).toBe('14:00'); // EST
    expect(DateTime.fromMillis(sun[0].start).toUTC().toFormat('HH:mm')).toBe('13:00'); // EDT
    expect(sun.map((s) => fmt(s.start).slice(11))).toEqual(['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00']);
  });

  it('spring forward: a window spanning the gap only contains real hours', () => {
    const p = policy({ weeklyRules: [{ weekday: 7, startMinute: 60, endMinute: 240 }] }); // Sun 01:00–04:00
    const slots = computeAvailableSlots(p, event(), {
      now: at('2026-03-01T00:00'),
      calendarBusy: [],
      interviews: [],
      ...day('2026-03-08'),
    });
    // 01:00 EST → 04:00 EDT is only two real hours.
    expect(slots.map((s) => fmt(s.start).slice(11))).toEqual(['01:00', '03:00']);
    expect(slots.every((s) => s.end - s.start === 3_600_000)).toBe(true);
  });

  it('fall back (US, 2026-11-01): the repeated hour yields an extra real slot', () => {
    const p = policy({ weeklyRules: [{ weekday: 7, startMinute: 60, endMinute: 180 }] }); // Sun 01:00–03:00
    const slots = computeAvailableSlots(p, event(), {
      now: at('2026-10-25T00:00'),
      calendarBusy: [],
      interviews: [],
      ...day('2026-11-01'),
    });
    expect(slots.map((s) => DateTime.fromMillis(s.start).toUTC().toFormat('HH:mm'))).toEqual(['05:00', '06:00', '07:00']);
  });

  it('London → New York offset changes are handled per date (EU and US switch on different days)', () => {
    // 2026-03-29 Europe switches; between 03-08 and 03-29 the NY–London gap is 4h instead of 5h.
    const p = policy({ timezone: LONDON, weeklyRules: [{ weekday: 3, startMinute: 540, endMinute: 600 }] });
    const now = at('2026-03-01T00:00', LONDON);
    const mar18 = computeAvailableSlots(p, event(), { now, calendarBusy: [], interviews: [], ...day('2026-03-18', LONDON) });
    const apr1 = computeAvailableSlots(p, event(), { now, calendarBusy: [], interviews: [], ...day('2026-04-01', LONDON) });
    expect(fmt(mar18[0].start, NY)).toBe('2026-03-18 05:00');
    expect(fmt(apr1[0].start, NY)).toBe('2026-04-01 04:00');
  });

  it('localMinuteToInstant treats 24:00 as the next local midnight across DST', () => {
    const end = localMinuteToInstant('2026-03-08', 1440, NY);
    expect(DateTime.fromMillis(end, { zone: NY }).toISO()).toBe('2026-03-09T00:00:00.000-04:00');
    const start = localMinuteToInstant('2026-03-08', 0, NY);
    expect((end - start) / 3_600_000).toBe(23);
  });
});

describe('checkSlot', () => {
  const base = { now: NOW, calendarBusy: [], interviews: [] };

  it('accepts an offered slot', () => {
    expect(checkSlot(policy(), event(), base, at('2026-10-05T10:00'))).toEqual({ available: true });
  });

  it('rejects times off the slot grid or outside working hours', () => {
    expect(checkSlot(policy(), event(), base, at('2026-10-05T10:10'))).toEqual({
      available: false,
      reason: 'outside_availability',
    });
    expect(checkSlot(policy(), event(), base, at('2026-10-05T18:00'))).toEqual({
      available: false,
      reason: 'outside_availability',
    });
    expect(checkSlot(policy(), event(), base, at('2026-10-04T10:00'))).toEqual({
      available: false,
      reason: 'outside_availability',
    });
  });

  it('reports the specific conflict reason', () => {
    expect(
      checkSlot(policy(), event(), { ...base, calendarBusy: [{ start: at('2026-10-05T10:30'), end: at('2026-10-05T10:45') }] }, at('2026-10-05T10:00')),
    ).toEqual({ available: false, reason: 'calendar_conflict' });
    expect(
      checkSlot(
        policy(),
        event(),
        {
          ...base,
          interviews: [
            { id: 'x', start: at('2026-10-05T10:00'), end: at('2026-10-05T11:00'), bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
          ],
        },
        at('2026-10-05T10:00'),
      ),
    ).toEqual({ available: false, reason: 'interview_conflict' });
    expect(checkSlot(policy(), event({ minimumNoticeMinutes: 60 * 24 * 7 }), base, at('2026-10-05T10:00'))).toEqual({
      available: false,
      reason: 'too_soon',
    });
    expect(checkSlot(policy(), event({ maxDaysInFuture: 2 }), base, at('2026-10-05T10:00'))).toEqual({
      available: false,
      reason: 'too_far',
    });
  });

  it('lets hosts override working hours but never conflicts', () => {
    expect(checkSlot(policy(), event(), base, at('2026-10-05T19:10'), { ignoreWorkingHours: true })).toEqual({
      available: true,
    });
    expect(
      checkSlot(
        policy(),
        event(),
        { ...base, calendarBusy: [{ start: at('2026-10-05T19:00'), end: at('2026-10-05T20:00') }] },
        at('2026-10-05T19:10'),
        { ignoreWorkingHours: true },
      ),
    ).toEqual({ available: false, reason: 'calendar_conflict' });
  });

  it('agrees with computeAvailableSlots for every slot in a busy week', () => {
    const interviews: ExistingInterview[] = [
      { id: 'a', start: at('2026-10-06T11:00'), end: at('2026-10-06T12:00'), bufferBeforeMinutes: 10, bufferAfterMinutes: 20 },
      { id: 'b', start: at('2026-10-07T09:30'), end: at('2026-10-07T10:15'), bufferBeforeMinutes: 0, bufferAfterMinutes: 5 },
    ];
    const calendarBusy = [{ start: at('2026-10-08T13:00'), end: at('2026-10-08T15:30') }];
    const ev = event({ durationMinutes: 45, slotIntervalMinutes: 15, bufferBeforeMinutes: 5, bufferAfterMinutes: 10 });
    const ctx = { now: NOW, calendarBusy, interviews };
    const range = { rangeStart: at('2026-10-05T00:00'), rangeEnd: at('2026-10-10T00:00') };
    const offered = new Set(computeAvailableSlots(policy(), ev, { ...ctx, ...range }).map((s) => s.start));
    for (let t = range.rangeStart; t < range.rangeEnd; t += 15 * 60_000) {
      expect(checkSlot(policy(), ev, ctx, t).available).toBe(offered.has(t));
    }
  });
});
