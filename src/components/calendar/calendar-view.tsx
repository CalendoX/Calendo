'use client';

import { DateTime } from 'luxon';
import { ArrowRight, CalendarClock, ChevronLeft, ChevronRight, Clock, ExternalLink, Globe2, MapPin, Phone, RefreshCw, User, Users, Video } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { InterviewStatusBadge, SyncBadge } from '@/components/interviews/status-badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Select } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Segmented } from '@/components/ui/tabs';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { zoneLabel } from '@/lib/time';

type View = 'month' | 'week' | 'day' | 'agenda';

interface CalItem {
  id: string;
  title: string;
  status: 'scheduled' | 'rescheduled' | 'cancelled' | 'completed' | 'no_show';
  startAt: string;
  endAt: string;
  candidate: { name: string; email: string };
  eventType: { name: string; color: string };
  host: { id: string; name: string };
  locationType: string;
  meetingStatus: 'pending' | 'synced' | 'failed' | 'cancelled' | 'deleted_externally' | null;
  calendarStatus: 'pending' | 'synced' | 'failed' | 'cancelled' | 'deleted_externally' | null;
}

/** An event from the user's own Google Calendar (see /api/calendar/busy). */
interface ExternalEvent {
  id: string;
  calendarName: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  videoUrl: string | null;
  htmlLink: string | null;
  organizer: { email: string; name: string | null } | null;
  attendees: { email: string; name: string | null; responseStatus: string | null; organizer: boolean }[];
}

type GridEntry = { kind: 'interview'; interview: CalItem } | { kind: 'external'; event: ExternalEvent };

const RESPONSE_LABELS: Record<string, string> = { accepted: 'Going', declined: 'Declined', tentative: 'Maybe', needsAction: 'Awaiting reply' };

/** The working day gets full contrast; the hours outside it are dimmed so the eye lands here first. */
const WORK_START_HOUR = 8;
const WORK_END_HOUR = 19;
/**
 * The hour height is sized so the whole working day (plus a quarter hour either side) fits the
 * visible grid without scrolling, within bounds that keep a 15-minute interview legible and stop a
 * tall monitor from stretching the day out. DEFAULT_HOUR_PX only covers the server render.
 */
const FIT_HOURS = WORK_END_HOUR - WORK_START_HOUR + 0.5;
const MIN_HOUR_PX = 44;
const MAX_HOUR_PX = 64;
const DEFAULT_HOUR_PX = 52;
/** Chips are drawn at their real duration; only something shorter than this is stretched to it. */
const MIN_CHIP_PX = 10;
/** Room for one line of chip text — what a later chip must leave clear before it may stack on top. */
const NEST_PX = 18;
const CHIP_LINE_PX = 14;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/**
 * Not real-time on purpose: the view re-fetches quietly when the user comes back to the tab and the
 * data is older than STALE_AFTER_MS, and every POLL_INTERVAL_MS while the tab stays visible. Hidden
 * tabs never poll, and the Google overlay is additionally cached on the server.
 */
const STALE_AFTER_MS = 60_000;
const POLL_INTERVAL_MS = 5 * 60_000;

const LOCATION_ICONS: Record<string, typeof Video> = { zoom: Video, google_meet: Video, phone: Phone, in_person: MapPin, custom: MapPin };

/** Event-type colours come from a fixed 6-digit hex palette, so an alpha byte can just be appended. */
function tint(hex: string, alpha: string): string | undefined {
  return /^#[0-9a-f]{6}$/i.test(hex) ? `${hex}${alpha}` : undefined;
}

/**
 * The same soft fill as `tint`, but pre-composited over white so it is opaque. Chips in the time
 * grid can be lifted over their neighbours on hover, and a translucent fill would let the chip
 * underneath show through.
 */
function softFill(hex: string, ratio = 0.13): string | undefined {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return undefined;
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16));
  const over = (c: number) => Math.round(c * ratio + 255 * (1 - ratio));
  return `rgb(${over(r)} ${over(g)} ${over(b)})`;
}

function rangeFor(view: View, cursor: DateTime) {
  if (view === 'month') {
    const first = cursor.startOf('month');
    const start = first.minus({ days: first.weekday - 1 });
    return { start, end: start.plus({ weeks: 6 }) };
  }
  if (view === 'agenda') {
    const start = cursor.startOf('month');
    return { start, end: start.plus({ months: 1 }) };
  }
  if (view === 'week') {
    const start = cursor.startOf('week');
    return { start, end: start.plus({ weeks: 1 }) };
  }
  const start = cursor.startOf('day');
  return { start, end: start.plus({ days: 1 }) };
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

/**
 * Places the events of one day column the way Google Calendar does. Events that start together
 * sit side by side in lanes. An event that starts at least a title line (NEST_PX) below another
 * stacks on top of it, indented, instead of squeezing both into half-width columns: the earlier
 * title stays readable and the later chip keeps most of the width. Chips then widen into any lanes
 * to their right that are free for their whole duration. `left`/`right` are fractions of the column.
 * Back-to-back events don't overlap, so they stack in one lane rather than splitting it.
 */
function layoutDay<T>(items: { item: T; start: number; end: number }[]) {
  type Placed = { item: T; start: number; end: number; lane: number; depth: number; left: number; right: number };
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Placed[] = [];
  let cluster: Placed[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((c) => c.lane + 1));
    for (const c of cluster) {
      let span = 1;
      while (c.lane + span < lanes && !cluster.some((o) => o.lane === c.lane + span && overlaps(o, c))) span++;
      // Each level of stacking indents by 35% of what's left, so deep stacks never run out of room.
      c.left = (c.lane + (1 - 0.65 ** c.depth)) / lanes;
      c.right = (c.lane + span) / lanes;
    }
    out.push(...cluster);
    cluster = [];
  };
  for (const ev of sorted) {
    if (ev.start >= clusterEnd && cluster.length) flush();
    const lanes = Array.from({ length: Math.max(0, ...cluster.map((c) => c.lane + 1)) }, (_, i) => i);
    const under = (lane: number) => cluster.filter((c) => c.lane === lane && overlaps(c, ev));
    // A lane that's free for this event first, so nothing gets covered when it needn't be; then
    // stacking where every chip underneath started a title line earlier; otherwise a new lane.
    const lane =
      lanes.find((l) => under(l).length === 0) ?? lanes.find((l) => under(l).every((c) => ev.start - c.start >= NEST_PX)) ?? lanes.length;
    const below = under(lane);
    cluster.push({ ...ev, lane, depth: below.length ? Math.max(...below.map((c) => c.depth)) + 1 : 0, left: 0, right: 1 });
    clusterEnd = Math.max(clusterEnd, ev.end);
  }
  if (cluster.length) flush();
  return out;
}

/** Google Calendar's compact clock: "3pm", "3:30pm". */
function clock(dt: DateTime, meridiem = true) {
  const time = dt.toFormat(dt.minute === 0 ? 'h' : 'h:mm');
  return meridiem ? `${time}${dt.toFormat('a').toLowerCase()}` : time;
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** "10 – 11am", or "11:30am – 12:15pm" when the range crosses noon. */
function clockRange(start: DateTime, end: DateTime) {
  return `${clock(start, start.toFormat('a') !== end.toFormat('a'))} – ${clock(end)}`;
}

function LocationIcon({ type, className }: { type: string; className?: string }) {
  const Icon = LOCATION_ICONS[type] ?? MapPin;
  return <Icon className={className} aria-hidden="true" />;
}

export function CalendarView({
  scope,
  timezone,
  showInterviewer,
  interviewers = [],
  defaultView = 'week',
  fill = false,
}: {
  scope: 'mine' | 'team';
  timezone: string;
  showInterviewer: boolean;
  interviewers?: { id: string; name: string }[];
  defaultView?: View;
  /**
   * Stretch to the height of the parent instead of the default boxed height. The calendar page
   * turns this on so the grid uses the whole viewport; embedded uses (the interviews browser)
   * leave it off and keep flowing with the rest of the page. Only takes effect from `sm` up —
   * on a phone the agenda is a long list that should scroll with the document, not inside a box.
   */
  fill?: boolean;
}) {
  const [view, setView] = useState<View>(defaultView);
  const [cursor, setCursor] = useState<DateTime>(() => DateTime.now().setZone(timezone));
  const [items, setItems] = useState<CalItem[] | null>(null);
  const [busy, setBusy] = useState<{ start: string; end: string }[]>([]);
  const [external, setExternal] = useState<ExternalEvent[]>([]);
  const [busyState, setBusyState] = useState<'none' | 'ok' | 'unavailable'>('none');
  const [error, setError] = useState<string | null>(null);
  const [interviewerId, setInterviewerId] = useState('');
  const [showCancelled, setShowCancelled] = useState(false);
  const [selected, setSelected] = useState<CalItem | null>(null);
  const [selectedExternal, setSelectedExternal] = useState<ExternalEvent | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hourPx, setHourPx] = useState(DEFAULT_HOUR_PX);
  const [refreshing, setRefreshing] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const lastFetchRef = useRef(0);
  const range = useMemo(() => rangeFor(view, cursor), [view, cursor]);
  const isGrid = view === 'week' || view === 'day';
  // The current time only exists in the browser (and ticks every minute), so the "now" line and
  // today's highlight can't disagree with the server-rendered HTML during hydration.
  const [now, setNow] = useState<DateTime | null>(null);
  useEffect(() => {
    const tick = () => setNow(DateTime.now().setZone(timezone));
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [timezone]);

  // A seven-column grid is unreadable on a phone, so open on the agenda there instead. This runs
  // after mount (never during render) to keep the server and client markup identical.
  useEffect(() => {
    if (window.matchMedia('(max-width: 640px)').matches) setView('agenda');
  }, []);

  /** `quiet` background refreshes keep what's on screen when a request fails. */
  const load = useCallback(
    async (signal: AbortSignal, quiet: boolean) => {
      lastFetchRef.current = Date.now();
      if (!quiet) setError(null);
      const qs = new URLSearchParams({ start: range.start.toUTC().toISO()!, end: range.end.toUTC().toISO()!, scope });
      if (interviewerId) qs.set('interviewerId', interviewerId);
      if (showCancelled) qs.set('includeCancelled', 'true');
      try {
        const res = await api<{ items: CalItem[] }>(`/api/calendar/events?${qs}`, { signal });
        setItems(res.items);
        setError(null);
      } catch (err) {
        if (!signal.aborted && !quiet) setError(errorMessage(err, 'Could not load interviews.'));
      }
      if (isGrid && scope === 'mine') {
        try {
          const b = await api<{ connected: boolean; available: boolean; events: ExternalEvent[]; busy: { start: string; end: string }[] }>(
            `/api/calendar/busy?start=${encodeURIComponent(range.start.toUTC().toISO()!)}&end=${encodeURIComponent(range.end.toUTC().toISO()!)}`,
            { signal },
          );
          setBusy(b.busy);
          setExternal(b.events);
          setBusyState(!b.connected ? 'none' : b.available ? 'ok' : 'unavailable');
        } catch {
          if (!quiet && !signal.aborted) {
            setBusy([]);
            setExternal([]);
          }
        }
      } else {
        setBusy([]);
        setExternal([]);
        setBusyState('none');
      }
    },
    [range, scope, interviewerId, showCancelled, isGrid],
  );

  /** Starts a fetch, cancelling any still in flight. Only 'initial' blanks the view while loading. */
  const reload = useCallback(
    (mode: 'initial' | 'quiet' | 'manual') => {
      requestRef.current?.abort();
      const ctrl = new AbortController();
      requestRef.current = ctrl;
      if (mode === 'initial') setItems(null);
      if (mode === 'manual') setRefreshing(true);
      void load(ctrl.signal, mode === 'quiet').finally(() => {
        if (requestRef.current === ctrl) setRefreshing(false);
      });
    },
    [load],
  );

  useEffect(() => {
    reload('initial');
    return () => requestRef.current?.abort();
  }, [reload]);

  useEffect(() => {
    const refreshIfStale = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastFetchRef.current >= STALE_AFTER_MS) reload('quiet');
    };
    const id = setInterval(refreshIfStale, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', refreshIfStale);
    window.addEventListener('focus', refreshIfStale);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', refreshIfStale);
      window.removeEventListener('focus', refreshIfStale);
    };
  }, [reload]);

  // Layout effects so the grid is measured and scrolled before it is first painted.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!isGrid || !el) return;
    const fit = () => setHourPx(Math.min(MAX_HOUR_PX, Math.max(MIN_HOUR_PX, Math.floor(el.clientHeight / FIT_HOURS))));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [isGrid]);

  // Opening the grid starts at the working day; a resize that changes the hour height keeps the
  // same time at the top instead of jumping.
  const scrolledAtHourPx = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!isGrid || !el) {
      scrolledAtHourPx.current = null;
      return;
    }
    const prev = scrolledAtHourPx.current;
    el.scrollTop = prev === null ? hourPx * (WORK_START_HOUR - 0.25) : (el.scrollTop * hourPx) / prev;
    scrolledAtHourPx.current = hourPx;
  }, [isGrid, hourPx]);

  const step = (dir: 1 | -1) =>
    setCursor((c) => c.plus(view === 'week' ? { weeks: dir } : view === 'day' ? { days: dir } : { months: dir }));
  const title =
    view === 'month' || view === 'agenda'
      ? cursor.toFormat('LLLL yyyy')
      : view === 'week'
        ? `${range.start.toFormat('LLL d')} – ${range.end.minus({ days: 1 }).toFormat(range.start.month === range.end.minus({ days: 1 }).month ? 'd, yyyy' : 'LLL d, yyyy')}`
        : cursor.toFormat('cccc, LLLL d, yyyy');

  const byDay = useMemo(() => {
    const map = new Map<string, CalItem[]>();
    for (const i of items ?? []) {
      const d = DateTime.fromISO(i.startAt, { zone: timezone }).toISODate()!;
      (map.get(d) ?? map.set(d, []).get(d)!).push(i);
    }
    return map;
  }, [items, timezone]);

  const liveItems = useMemo(() => (items ?? []).filter((i) => i.status !== 'cancelled'), [items]);
  /**
   * The headline count for the range on screen. `external` is only ever filled for the week and day
   * grids, which draw the Google overlay; the month and agenda views show interviews alone and so
   * count them alone. Either way the number matches what the view actually shows.
   */
  const shownCount = liveItems.length + external.length;
  const shownNoun = external.length > 0 ? 'event' : 'interview';
  /** The next interview that hasn't started yet — called out in the sidebar and the agenda. */
  const nextUp = useMemo(() => {
    if (!now) return null;
    return liveItems.filter((i) => DateTime.fromISO(i.startAt, { zone: timezone }) >= now).sort((a, b) => a.startAt.localeCompare(b.startAt))[0] ?? null;
  }, [liveItems, now, timezone]);

  /** Distinct event types in view, for the colour key under the toolbar. */
  const legend = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of items ?? []) if (!map.has(i.eventType.name)) map.set(i.eventType.name, i.eventType.color);
    return [...map.entries()].slice(0, 6);
  }, [items]);

  const days = view === 'week' ? Array.from({ length: 7 }, (_, i) => range.start.plus({ days: i })) : [range.start];
  // Scoped to the days on screen so the all-day band never appears empty (a day view inside a
  // week that has all-day events elsewhere would otherwise render a bare "All day" strip).
  const allDayEvents = useMemo(
    () =>
      external.filter(
        (e) => e.allDay && DateTime.fromISO(e.start, { zone: timezone }) < range.end && DateTime.fromISO(e.end, { zone: timezone }) > range.start,
      ),
    [external, range, timezone],
  );
  /** The Google Calendar events drawn in one day column, all-day ones included. */
  const externalOn = (d: DateTime) => {
    const dayStart = d.startOf('day');
    const dayEnd = dayStart.plus({ days: 1 });
    return external.filter((e) => DateTime.fromISO(e.start, { zone: timezone }) < dayEnd && DateTime.fromISO(e.end, { zone: timezone }) > dayStart);
  };
  const gridColumns = `60px repeat(${days.length}, minmax(0, 1fr))`;

  return (
    <Card className={cn('overflow-hidden', fill && 'sm:flex sm:min-h-0 sm:flex-1 sm:flex-col')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-100 bg-gradient-to-b from-zinc-50/80 to-white px-3 py-3 sm:px-4">
        <div className="flex items-center gap-1.5">
          <Button variant="secondary" size="sm" onClick={() => setCursor(DateTime.now().setZone(timezone))}>
            Today
          </Button>
          <div className="flex items-center overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
            <button
              type="button"
              onClick={() => step(-1)}
              aria-label="Previous"
              className="flex size-8 items-center justify-center text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-900"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="h-5 w-px bg-zinc-200" aria-hidden="true" />
            <button
              type="button"
              onClick={() => step(1)}
              aria-label="Next"
              className="flex size-8 items-center justify-center text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-900"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => reload('manual')}
            disabled={refreshing}
            aria-label="Refresh"
            title="Refresh"
            className="flex size-8 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 shadow-sm transition-colors hover:bg-zinc-50 hover:text-zinc-900 disabled:text-zinc-400"
          >
            <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
          </button>
        </div>
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-semibold tracking-tight text-zinc-900" aria-live="polite">
            {title}
          </h2>
          <p className="flex items-center gap-1.5 text-xs text-zinc-500">
            {items === null ? (
              <>
                <Spinner className="size-3 text-zinc-400" /> Loading…
              </>
            ) : (
              <>
                <span
                  className="font-medium text-zinc-600"
                  title={external.length > 0 ? `${plural(liveItems.length, 'interview')} · ${plural(external.length, 'Google Calendar event')}` : undefined}
                >
                  {plural(shownCount, shownNoun)}
                </span>
                <span className="text-zinc-300">·</span>
                <span className="truncate">{zoneLabel(timezone)}</span>
              </>
            )}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {showInterviewer && interviewers.length > 0 && (
            <Select aria-label="Interviewer" className="h-8 w-auto text-sm" value={interviewerId} onChange={(e) => setInterviewerId(e.target.value)}>
              <option value="">All interviewers</option>
              {interviewers.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </Select>
          )}
          <label className="flex items-center gap-1.5 text-sm text-zinc-600">
            <input type="checkbox" className="size-4 rounded border-zinc-300 accent-brand-600" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
            Cancelled
          </label>
          <Segmented<View>
            value={view}
            onChange={setView}
            options={[
              { value: 'month', label: 'Month' },
              { value: 'week', label: 'Week' },
              { value: 'day', label: 'Day' },
              { value: 'agenda', label: 'Agenda' },
            ]}
          />
        </div>
      </div>

      {legend.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-zinc-100 bg-white px-3 py-2 sm:px-4">
          {legend.map(([name, color]) => (
            <span key={name} className="inline-flex items-center gap-1.5 text-[11px] font-medium text-zinc-600">
              <span className="size-2.5 rounded-[3px]" style={{ backgroundColor: color }} aria-hidden="true" />
              {name}
            </span>
          ))}
          {isGrid && busyState === 'ok' && (
            <>
              <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500">
                <span className="size-2.5 rounded-[3px] border border-zinc-300 bg-zinc-100" aria-hidden="true" />
                Google Calendar
              </span>
              <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500">
                <span
                  className="size-2.5 rounded-[3px] border border-dashed border-zinc-300 bg-[repeating-linear-gradient(135deg,transparent,transparent_2px,rgba(0,0,0,0.08)_2px,rgba(0,0,0,0.08)_4px)]"
                  aria-hidden="true"
                />
                Busy
              </span>
            </>
          )}
        </div>
      )}

      {error && <p className="border-b border-rose-100 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</p>}

      {view === 'month' ? (
        <div className={cn('grid grid-cols-7', fill && 'sm:min-h-0 sm:flex-1 sm:grid-rows-[auto_repeat(6,minmax(0,1fr))] sm:overflow-y-auto')}>
          {WEEKDAYS.map((d) => (
            <div key={d} className="border-b border-zinc-100 bg-zinc-50/50 px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
              <span className="hidden sm:inline">{d}</span>
              <span className="sm:hidden">{d[0]}</span>
            </div>
          ))}
          {Array.from({ length: 42 }, (_, i) => range.start.plus({ days: i })).map((day) => {
            const iso = day.toISODate()!;
            const list = byDay.get(iso) ?? [];
            const inMonth = day.month === cursor.month;
            const isToday = now !== null && day.hasSame(now, 'day');
            return (
              <div
                key={iso}
                className={cn(
                  'group border-b border-r border-zinc-100 p-1.5 transition-colors [&:nth-child(7n)]:border-r-0',
                  fill ? 'min-h-[104px] sm:min-h-0 sm:overflow-hidden' : 'min-h-[124px]',
                  !inMonth && 'bg-zinc-50/60',
                  isToday && 'bg-brand-50/40',
                )}
              >
                <div className="mb-1 flex items-center justify-between">
                  <button
                    onClick={() => {
                      setCursor(day);
                      setView('day');
                    }}
                    aria-label={`Open ${day.toFormat('cccc, LLLL d')}`}
                    className={cn(
                      'flex size-6 items-center justify-center rounded-full text-xs font-semibold transition-colors',
                      isToday ? 'bg-brand-600 text-white shadow-sm' : inMonth ? 'text-zinc-700 hover:bg-zinc-200/70' : 'text-zinc-400',
                    )}
                  >
                    {day.day}
                  </button>
                  {list.length > 0 && (
                    <span className="tabular rounded-full bg-zinc-100 px-1.5 text-[10px] font-semibold text-zinc-500 opacity-0 transition-opacity group-hover:opacity-100">
                      {list.length}
                    </span>
                  )}
                </div>
                <div className="space-y-1">
                  {list.slice(0, 3).map((i) => {
                    const cancelled = i.status === 'cancelled';
                    return (
                      <button
                        key={i.id}
                        onClick={() => setSelected(i)}
                        title={`${DateTime.fromISO(i.startAt, { zone: timezone }).toFormat('h:mm a')} · ${i.candidate.name} · ${i.eventType.name}`}
                        className={cn(
                          'flex w-full items-center gap-1.5 overflow-hidden rounded-md py-[3px] pl-1.5 pr-1 text-left text-[11px] transition',
                          cancelled ? 'bg-zinc-100 text-zinc-400 line-through' : 'hover:brightness-[0.97]',
                        )}
                        style={cancelled ? undefined : { backgroundColor: tint(i.eventType.color, '1f'), borderLeft: `2px solid ${i.eventType.color}` }}
                      >
                        <span className="tabular shrink-0 font-medium text-zinc-500">{DateTime.fromISO(i.startAt, { zone: timezone }).toFormat('h:mm')}</span>
                        <span className={cn('truncate font-semibold', cancelled ? 'text-zinc-400' : 'text-zinc-800')}>{i.candidate.name}</span>
                      </button>
                    );
                  })}
                  {list.length > 3 && (
                    <button
                      className="w-full rounded px-1.5 py-px text-left text-[11px] font-semibold text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800"
                      onClick={() => {
                        setCursor(day);
                        setView('day');
                      }}
                    >
                      +{list.length - 3} more
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : view === 'agenda' ? (
        <AgendaView
          items={items}
          timezone={timezone}
          nextUpId={nextUp?.id ?? null}
          now={now}
          showInterviewer={showInterviewer}
          monthLabel={cursor.toFormat('LLLL yyyy')}
          onSelect={setSelected}
          fill={fill}
        />
      ) : (
        <div className={cn('grid xl:grid-cols-[1fr_300px]', fill && 'sm:min-h-0 sm:flex-1')}>
          <div className={cn('min-w-0 border-zinc-100 xl:border-r', fill && 'sm:flex sm:min-h-0 sm:flex-col')}>
            <div className={cn('scrollbar-thin overflow-x-auto', fill && 'sm:flex sm:min-h-0 sm:flex-1 sm:flex-col')}>
              <div className={cn(view === 'week' && 'min-w-[640px]', fill && 'sm:flex sm:min-h-0 sm:flex-1 sm:flex-col')}>
                <div className="grid border-b border-zinc-100 bg-white" style={{ gridTemplateColumns: gridColumns }}>
                  <div />
                  {days.map((d) => {
                    const isToday = now !== null && d.hasSame(now, 'day');
                    // Everything the column actually shows: interviews booked here plus the events
                    // from the user's own Google Calendar. With the overlay on, "events" is the
                    // honest word for a total that is no longer interviews alone.
                    const booked = (byDay.get(d.toISODate()!) ?? []).filter((i) => i.status !== 'cancelled').length;
                    const others = externalOn(d).length;
                    const count = booked + others;
                    const noun = external.length > 0 ? 'event' : 'interview';
                    return (
                      <button
                        key={d.toISODate()}
                        type="button"
                        onClick={() => {
                          setCursor(d);
                          setView('day');
                        }}
                        title={others > 0 ? `${plural(booked, 'interview')} · ${plural(others, 'Google Calendar event')}` : undefined}
                        className={cn('border-l border-zinc-100 px-2 py-2 text-center transition-colors hover:bg-zinc-50', isToday && 'bg-brand-50/50')}
                      >
                        <p className={cn('text-[11px] font-semibold uppercase tracking-wide', isToday ? 'text-brand-700' : 'text-zinc-400')}>{d.toFormat('ccc')}</p>
                        <p
                          className={cn(
                            'mx-auto mt-0.5 flex size-8 items-center justify-center rounded-full text-sm font-semibold transition-colors',
                            isToday ? 'bg-brand-600 text-white shadow-sm' : 'text-zinc-800',
                          )}
                        >
                          {d.day}
                        </p>
                        <p className="tabular mt-0.5 h-3 text-[10px] font-medium text-zinc-400">{count > 0 ? plural(count, noun) : ''}</p>
                      </button>
                    );
                  })}
                </div>

                {allDayEvents.length > 0 && (
                  <div className="grid border-b border-zinc-100 bg-zinc-50/60" style={{ gridTemplateColumns: gridColumns }}>
                    <div className="px-2 py-2 text-right text-[10px] font-semibold uppercase tracking-wide text-zinc-400">All day</div>
                    {days.map((d) => {
                      const dayStart = d.startOf('day');
                      const dayEnd = dayStart.plus({ days: 1 });
                      const here = allDayEvents.filter(
                        (ev) => DateTime.fromISO(ev.start, { zone: timezone }) < dayEnd && DateTime.fromISO(ev.end, { zone: timezone }) > dayStart,
                      );
                      return (
                        <div key={d.toISODate()} className="space-y-1 border-l border-zinc-100 p-1">
                          {here.map((ev) => (
                            <button
                              key={ev.id}
                              onClick={() => setSelectedExternal(ev)}
                              title={ev.title}
                              className="block w-full truncate rounded-md border-l-2 border-l-zinc-400 bg-white px-1.5 py-1 text-left text-[11px] font-medium text-zinc-600 ring-1 ring-zinc-200/80 transition hover:bg-zinc-50 hover:text-zinc-900"
                            >
                              {ev.title}
                            </button>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}

                <div ref={scrollRef} className={cn('scrollbar-thin relative overflow-y-auto', fill ? 'max-h-[640px] sm:max-h-none sm:min-h-[320px] sm:flex-1' : 'max-h-[640px]')}>
                  <div className="grid" style={{ gridTemplateColumns: gridColumns }}>
                    <div className="relative bg-white" style={{ height: hourPx * 24 }}>
                      {Array.from({ length: 24 }, (_, h) => (
                        <span key={h} className="tabular absolute right-2 -translate-y-1/2 text-[11px] font-medium text-zinc-400" style={{ top: h * hourPx }}>
                          {h === 0 ? '' : DateTime.fromObject({ hour: h }).toFormat('h a')}
                        </span>
                      ))}
                      {now && days.some((d) => d.hasSame(now, 'day')) && (
                        <span
                          className="tabular absolute right-1.5 z-10 -translate-y-1/2 rounded bg-rose-500 px-1 py-px text-[10px] font-semibold text-white shadow-sm"
                          style={{ top: (now.diff(now.startOf('day'), 'minutes').minutes / 60) * hourPx }}
                        >
                          {now.toFormat('h:mm')}
                        </span>
                      )}
                    </div>
                    {days.map((d) => {
                      const dayStart = d.startOf('day');
                      const dayEnd = dayStart.plus({ days: 1 });
                      const isToday = now !== null && d.hasSame(now, 'day');
                      const toPx = (dt: DateTime) => (dt.diff(dayStart, 'minutes').minutes / 60) * hourPx;
                      const place = (s: DateTime, e: DateTime) => {
                        const start = toPx(s < dayStart ? dayStart : s);
                        return { start, end: Math.max(start + MIN_CHIP_PX, toPx(e < dayEnd ? e : dayEnd)) };
                      };
                      const entries = layoutDay<GridEntry>([
                        ...(byDay.get(d.toISODate()!) ?? []).map((interview) => ({
                          item: { kind: 'interview' as const, interview },
                          ...place(DateTime.fromISO(interview.startAt, { zone: timezone }), DateTime.fromISO(interview.endAt, { zone: timezone })),
                        })),
                        ...external
                          .filter((ev) => !ev.allDay)
                          .map((event) => ({ event, s: DateTime.fromISO(event.start, { zone: timezone }), e: DateTime.fromISO(event.end, { zone: timezone }) }))
                          .filter(({ s, e }) => s < dayEnd && e > dayStart)
                          .map(({ event, s, e }) => ({ item: { kind: 'external' as const, event }, ...place(s, e) })),
                      ]);
                      // Free/busy-only calendars share no details, so their time shows as a hatched band behind everything.
                      const busyBands = busy
                        .map((b) => ({ s: DateTime.fromISO(b.start, { zone: timezone }), e: DateTime.fromISO(b.end, { zone: timezone }) }))
                        .filter((b) => b.s < dayEnd && b.e > dayStart);
                      return (
                        <div key={d.toISODate()} className={cn('relative border-l border-zinc-100', isToday && 'bg-brand-50/25')} style={{ height: hourPx * 24 }}>
                          <div className="pointer-events-none absolute inset-x-0 top-0 bg-zinc-100/50" style={{ height: WORK_START_HOUR * hourPx }} />
                          <div className="pointer-events-none absolute inset-x-0 bg-zinc-100/50" style={{ top: WORK_END_HOUR * hourPx, height: (24 - WORK_END_HOUR) * hourPx }} />
                          {Array.from({ length: 24 }, (_, h) => (
                            <div key={h} className="pointer-events-none absolute inset-x-0 border-t border-zinc-100" style={{ top: h * hourPx }} />
                          ))}
                          {Array.from({ length: 24 }, (_, h) => (
                            <div key={`half-${h}`} className="pointer-events-none absolute inset-x-0 border-t border-zinc-100/50" style={{ top: (h + 0.5) * hourPx }} />
                          ))}
                          {busyBands.map((b, idx) => {
                            const top = toPx(b.s < dayStart ? dayStart : b.s);
                            const bottom = toPx(b.e > dayEnd ? dayEnd : b.e);
                            return (
                              <div
                                key={`busy-${idx}`}
                                className="absolute inset-x-1 rounded-md border border-dashed border-zinc-300 bg-[repeating-linear-gradient(135deg,transparent,transparent_5px,rgba(0,0,0,0.045)_5px,rgba(0,0,0,0.045)_10px)] px-1.5 pt-0.5 text-left text-[10px] font-medium text-zinc-500"
                                style={{ top, height: Math.max(bottom - top, 14) }}
                                title="Busy in Google Calendar (details not shared with you)"
                              >
                                Busy
                              </div>
                            );
                          })}
                          {entries.map(({ item: entry, start, end, depth, left, right }) => {
                            const height = end - start - 1;
                            // What a chip shows depends on how many lines its real height holds: one
                            // line reads "Name, 3pm" like Google Calendar, two add the time range, three
                            // the interview type. Nothing is stretched to fit more text in.
                            const lines = Math.max(1, Math.floor((height - 4) / CHIP_LINE_PX));
                            // Width in week-column units, so a third of the wide day view isn't cramped.
                            const narrow = (right - left) * (7 / days.length) < 0.4;
                            const position = {
                              top: start,
                              height,
                              left: `calc(${left * 100}% + 2px)`,
                              width: `calc(${(right - left) * 100}% - 4px)`,
                              zIndex: depth + 1,
                            };
                            const chip = cn(
                              'absolute overflow-hidden text-left transition hover:z-20 hover:px-2 hover:shadow-md',
                              height < 16 ? 'rounded' : 'rounded-md',
                              height < 13 ? 'text-[10px] leading-none' : 'text-[11px] leading-[14px]',
                              // Flex, because a <button> otherwise centres its content vertically: text
                              // belongs at the top, where a chip stacked on top leaves it visible.
                              lines === 1 ? 'flex items-center' : 'flex flex-col py-[3px]',
                              narrow ? 'px-1' : 'px-2',
                              // A chip that doesn't span the column lifts to full width on hover.
                              right - left < 1 && 'hover:left-[2px]! hover:w-[calc(100%-4px)]!',
                              // Stacked chips get a white outline so the one underneath reads as separate.
                              depth > 0 && 'shadow-sm ring-1 ring-white',
                            );
                            if (entry.kind === 'external') {
                              const ev = entry.event;
                              const s = DateTime.fromISO(ev.start, { zone: timezone });
                              const e = DateTime.fromISO(ev.end, { zone: timezone });
                              return (
                                <button
                                  key={`x-${ev.id}`}
                                  onClick={() => setSelectedExternal(ev)}
                                  title={`${ev.title} · ${clockRange(s, e)} · ${ev.calendarName}`}
                                  className={cn(chip, 'border-l-2 border-l-zinc-400 bg-zinc-100', depth === 0 && 'ring-1 ring-zinc-200/70')}
                                  style={position}
                                >
                                  {lines === 1 ? (
                                    <span className="truncate">
                                      <span className="font-medium text-zinc-600">{ev.title}</span>
                                      {!narrow && <span className="tabular text-zinc-400">, {clock(s)}</span>}
                                    </span>
                                  ) : (
                                    <>
                                      <span className="block truncate font-medium text-zinc-600">{ev.title}</span>
                                      <span className="tabular block truncate text-zinc-400">{clockRange(s, e)}</span>
                                    </>
                                  )}
                                </button>
                              );
                            }
                            const item = entry.interview;
                            const cancelled = item.status === 'cancelled';
                            const s = DateTime.fromISO(item.startAt, { zone: timezone });
                            const e = DateTime.fromISO(item.endAt, { zone: timezone });
                            return (
                              <button
                                key={item.id}
                                onClick={() => setSelected(item)}
                                title={`${item.candidate.name} · ${clockRange(s, e)} · ${item.eventType.name}`}
                                className={cn(chip, cancelled && 'text-zinc-400', depth === 0 && cn('shadow-sm ring-1', cancelled ? 'ring-zinc-200' : 'ring-black/[0.07]'))}
                                style={{
                                  ...position,
                                  borderLeft: `3px solid ${cancelled ? '#d4d4d8' : item.eventType.color}`,
                                  backgroundColor: cancelled ? '#fafafa' : softFill(item.eventType.color),
                                  backgroundImage: cancelled
                                    ? 'repeating-linear-gradient(135deg,transparent,transparent 4px,rgba(0,0,0,0.05) 4px,rgba(0,0,0,0.05) 8px)'
                                    : undefined,
                                }}
                              >
                                {lines === 1 ? (
                                  <span className="truncate">
                                    <span className={cn('font-semibold', cancelled ? 'line-through' : 'text-zinc-900')}>{item.candidate.name}</span>
                                    {!narrow && <span className="tabular font-medium text-zinc-600">, {clock(s)}</span>}
                                  </span>
                                ) : (
                                  <>
                                    <span className={cn('flex items-center gap-1', cancelled && 'line-through')}>
                                      <span className={cn('truncate font-semibold', !cancelled && 'text-zinc-900')}>{item.candidate.name}</span>
                                      {/* Week columns are too narrow to spend the room on it; the name comes first. */}
                                      {view === 'day' && !narrow && <LocationIcon type={item.locationType} className="size-3 shrink-0 text-zinc-500" />}
                                    </span>
                                    <span className="tabular block truncate font-medium text-zinc-600">{clockRange(s, e)}</span>
                                    {lines >= 3 && !narrow && <span className="block truncate text-zinc-500">{item.eventType.name}</span>}
                                  </>
                                )}
                              </button>
                            );
                          })}
                          {isToday && now && (
                            <div className="pointer-events-none absolute inset-x-0 z-30 flex items-center" style={{ top: toPx(now) }}>
                              <span className="-ml-1 size-2.5 rounded-full bg-rose-500 ring-2 ring-white" />
                              <span className="h-px flex-1 bg-rose-500" />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
          <aside className={cn('hidden border-t border-zinc-100 xl:block xl:border-t-0', fill && 'xl:flex xl:min-h-0 xl:flex-col')}>
            <div className="border-b border-zinc-100 px-4 py-3">
              <p className="text-sm font-semibold text-zinc-900">{view === 'day' ? 'This day' : 'This week'}</p>
              <p className="text-xs text-zinc-500">
                {liveItems.length} {liveItems.length === 1 ? 'interview' : 'interviews'} · {zoneLabel(timezone)}
              </p>
              {busyState === 'unavailable' && <p className="mt-1 text-xs text-amber-700">Google Calendar events couldn’t be loaded.</p>}
            </div>
            {nextUp && (
              <div className="border-b border-zinc-100 bg-brand-50/50 px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-brand-700">Next up</p>
                <button onClick={() => setSelected(nextUp)} className="mt-1 block w-full text-left">
                  <span className="block truncate text-sm font-semibold text-zinc-900">{nextUp.candidate.name}</span>
                  <span className="tabular block text-xs text-zinc-600">{DateTime.fromISO(nextUp.startAt, { zone: timezone }).toFormat('ccc d · h:mm a')}</span>
                  <span className="block truncate text-xs text-zinc-500">{nextUp.eventType.name}</span>
                </button>
              </div>
            )}
            <ul className={cn('scrollbar-thin divide-y divide-zinc-100 overflow-y-auto', fill ? 'max-h-[560px] xl:max-h-none xl:min-h-0 xl:flex-1' : 'max-h-[560px]')}>
              {items !== null && items.length === 0 && (
                <li className="px-4 py-10 text-center">
                  <CalendarClock className="mx-auto size-6 text-zinc-300" />
                  <p className="mt-2 text-sm text-zinc-500">No interviews {view === 'day' ? 'this day' : 'this week'}</p>
                </li>
              )}
              {(items ?? []).map((i) => {
                const cancelled = i.status === 'cancelled';
                return (
                  <li key={i.id}>
                    <button onClick={() => setSelected(i)} className={cn('flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-zinc-50', i.id === nextUp?.id && 'bg-brand-50/30')}>
                      <span className="mt-1 h-9 w-1 shrink-0 rounded-full" style={{ backgroundColor: cancelled ? '#d4d4d8' : i.eventType.color }} />
                      <span className="min-w-0 flex-1">
                        <span className={cn('flex items-center gap-1.5', cancelled && 'line-through')}>
                          <span className={cn('truncate text-sm font-medium', cancelled ? 'text-zinc-400' : 'text-zinc-900')}>{i.candidate.name}</span>
                          <LocationIcon type={i.locationType} className="size-3 shrink-0 text-zinc-400" />
                        </span>
                        <span className="tabular block text-xs text-zinc-500">{DateTime.fromISO(i.startAt, { zone: timezone }).toFormat('ccc d · h:mm a')}</span>
                        <span className="block truncate text-xs text-zinc-400">{i.eventType.name}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>
        </div>
      )}

      <Dialog open={Boolean(selected)} onOpenChange={(o) => !o && setSelected(null)}>
        {selected && (
          <DialogContent title={selected.candidate.name} description={selected.eventType.name} size="sm">
            <ul className="space-y-3 text-sm text-zinc-700">
              <li className="flex gap-3">
                <Clock className="mt-0.5 size-4 shrink-0 text-zinc-400" />
                <span>
                  {DateTime.fromISO(selected.startAt, { zone: timezone }).toFormat('cccc, LLLL d')}
                  <br />
                  <span className="tabular text-zinc-500">
                    {DateTime.fromISO(selected.startAt, { zone: timezone }).toFormat('h:mm a')} – {DateTime.fromISO(selected.endAt, { zone: timezone }).toFormat('h:mm a ZZZZ')}
                  </span>
                </span>
              </li>
              <li className="flex gap-3">
                <Globe2 className="mt-0.5 size-4 shrink-0 text-zinc-400" /> {zoneLabel(timezone)}
              </li>
              <li className="flex gap-3">
                <User className="mt-0.5 size-4 shrink-0 text-zinc-400" /> {selected.candidate.email}
                <span className="text-zinc-400">· Interviewer: {selected.host.name}</span>
              </li>
              {selected.locationType === 'zoom' && (
                <li className="flex items-center gap-3">
                  <Video className="size-4 shrink-0 text-zinc-400" /> <SyncBadge status={selected.meetingStatus} label="Zoom" />
                </li>
              )}
              <li className="flex items-center gap-2 pt-1">
                <InterviewStatusBadge status={selected.status} />
                <SyncBadge status={selected.calendarStatus} label="Calendar" />
              </li>
            </ul>
            <DialogFooter>
              <Button asChild>
                <Link href={`/interviews/${selected.id}`}>
                  Open interview <ArrowRight />
                </Link>
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={Boolean(selectedExternal)} onOpenChange={(o) => !o && setSelectedExternal(null)}>
        {selectedExternal && <ExternalEventDetails event={selectedExternal} timezone={timezone} />}
      </Dialog>
    </Card>
  );
}

/**
 * Chronological list grouped by day. Research on calendar UX is consistent that an agenda beats a
 * grid for "what is actually booked", and it is the only view that stays usable on a phone.
 */
function AgendaView({
  items,
  timezone,
  nextUpId,
  now,
  showInterviewer,
  monthLabel,
  onSelect,
  fill = false,
}: {
  items: CalItem[] | null;
  timezone: string;
  nextUpId: string | null;
  now: DateTime | null;
  showInterviewer: boolean;
  monthLabel: string;
  onSelect: (i: CalItem) => void;
  fill?: boolean;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, CalItem[]>();
    for (const i of [...(items ?? [])].sort((a, b) => a.startAt.localeCompare(b.startAt))) {
      const d = DateTime.fromISO(i.startAt, { zone: timezone }).toISODate()!;
      (map.get(d) ?? map.set(d, []).get(d)!).push(i);
    }
    return [...map.entries()];
  }, [items, timezone]);

  if (items === null) {
    return (
      <div className={cn('flex items-center justify-center gap-2 px-4 py-16 text-sm text-zinc-500', fill && 'sm:min-h-0 sm:flex-1')}>
        <Spinner className="size-4 text-zinc-400" /> Loading interviews…
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className={cn('px-4 py-16 text-center', fill && 'sm:flex sm:min-h-0 sm:flex-1 sm:flex-col sm:justify-center')}>
        <CalendarClock className="mx-auto size-7 text-zinc-300" />
        <p className="mt-3 text-sm font-medium text-zinc-700">No interviews in {monthLabel}</p>
        <p className="mt-1 text-sm text-zinc-500">Bookings land here as soon as candidates schedule.</p>
      </div>
    );
  }

  return (
    <ol className={cn('divide-y divide-zinc-100', fill && 'scrollbar-thin sm:min-h-0 sm:flex-1 sm:overflow-y-auto')}>
      {groups.map(([iso, list]) => {
        const day = DateTime.fromISO(iso, { zone: timezone });
        const isToday = now !== null && day.hasSame(now, 'day');
        const isPast = now !== null && day.endOf('day') < now;
        return (
          <li key={iso} className={cn('flex gap-3 px-3 py-4 sm:gap-4 sm:px-5', isToday && 'bg-brand-50/30')}>
            <div className="w-12 shrink-0 text-center sm:w-14">
              <p className={cn('text-[11px] font-semibold uppercase tracking-wide', isToday ? 'text-brand-700' : 'text-zinc-400')}>{day.toFormat('ccc')}</p>
              <p
                className={cn(
                  'mx-auto mt-1 flex size-9 items-center justify-center rounded-xl text-base font-semibold',
                  isToday ? 'bg-brand-600 text-white shadow-sm' : isPast ? 'bg-zinc-100 text-zinc-400' : 'bg-zinc-100 text-zinc-800',
                )}
              >
                {day.day}
              </p>
            </div>
            <ul className="min-w-0 flex-1 space-y-2">
              {list.map((i) => {
                const cancelled = i.status === 'cancelled';
                const start = DateTime.fromISO(i.startAt, { zone: timezone });
                const end = DateTime.fromISO(i.endAt, { zone: timezone });
                return (
                  <li key={i.id}>
                    <button
                      onClick={() => onSelect(i)}
                      className={cn(
                        'flex w-full items-center gap-3 overflow-hidden rounded-xl border bg-white p-3 text-left transition',
                        'hover:-translate-y-px hover:shadow-card',
                        i.id === nextUpId ? 'border-brand-300 ring-1 ring-brand-200' : 'border-zinc-200/80',
                      )}
                      style={{ borderLeft: `4px solid ${cancelled ? '#d4d4d8' : i.eventType.color}` }}
                    >
                      <span className="tabular w-[74px] shrink-0 whitespace-nowrap sm:w-20">
                        <span className={cn('block text-sm font-semibold', cancelled ? 'text-zinc-400 line-through' : 'text-zinc-900')}>{start.toFormat('h:mm a')}</span>
                        <span className="block text-[11px] text-zinc-400">{end.toFormat('h:mm a')}</span>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={cn('block truncate text-sm font-semibold', cancelled ? 'text-zinc-400 line-through' : 'text-zinc-900')}>{i.candidate.name}</span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500">
                          <span className="inline-flex items-center gap-1">
                            <span className="size-2 rounded-full" style={{ backgroundColor: i.eventType.color }} aria-hidden="true" />
                            <span className="truncate">{i.eventType.name}</span>
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <LocationIcon type={i.locationType} className="size-3" />
                            {i.locationType === 'in_person' ? 'In person' : i.locationType === 'phone' ? 'Phone' : 'Video'}
                          </span>
                          {showInterviewer && <span className="truncate">{i.host.name}</span>}
                        </span>
                      </span>
                      <span className="hidden shrink-0 items-center gap-2 sm:flex">
                        {i.id === nextUpId && !cancelled && <span className="rounded-md bg-brand-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">Next up</span>}
                        <InterviewStatusBadge status={i.status} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </li>
        );
      })}
    </ol>
  );
}

function ExternalEventDetails({ event, timezone }: { event: ExternalEvent; timezone: string }) {
  const start = DateTime.fromISO(event.start, { zone: timezone });
  const end = DateTime.fromISO(event.end, { zone: timezone });
  const lastDay = end.minus({ days: 1 });
  return (
    <DialogContent title={event.title} description={`Google Calendar · ${event.calendarName}`} size="sm">
      <ul className="space-y-3 text-sm text-zinc-700">
        <li className="flex gap-3">
          <Clock className="mt-0.5 size-4 shrink-0 text-zinc-400" />
          <span>
            {event.allDay && !lastDay.hasSame(start, 'day') ? `${start.toFormat('cccc, LLLL d')} – ${lastDay.toFormat('cccc, LLLL d')}` : start.toFormat('cccc, LLLL d')}
            <br />
            <span className="tabular text-zinc-500">{event.allDay ? 'All day' : `${start.toFormat('h:mm a')} – ${end.toFormat('h:mm a ZZZZ')}`}</span>
          </span>
        </li>
        {event.location && (
          <li className="flex gap-3">
            <MapPin className="mt-0.5 size-4 shrink-0 text-zinc-400" /> <span className="min-w-0 break-words">{event.location}</span>
          </li>
        )}
        {event.videoUrl && (
          <li className="flex gap-3">
            <Video className="mt-0.5 size-4 shrink-0 text-zinc-400" />
            <a href={event.videoUrl} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate font-medium text-brand-700 hover:underline">
              Join video call
            </a>
          </li>
        )}
        {event.attendees.length > 0 ? (
          <li className="flex gap-3">
            <Users className="mt-0.5 size-4 shrink-0 text-zinc-400" />
            <div className="min-w-0 flex-1">
              <p className="text-zinc-500">
                {event.attendees.length} {event.attendees.length === 1 ? 'guest' : 'guests'}
              </p>
              <ul className="scrollbar-thin mt-1 max-h-48 space-y-1 overflow-y-auto">
                {event.attendees.map((a) => (
                  <li key={a.email} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate" title={a.email}>
                      {a.name ?? a.email}
                      {a.organizer && <span className="text-zinc-400"> · organizer</span>}
                    </span>
                    {a.responseStatus && <span className="shrink-0 text-xs text-zinc-400">{RESPONSE_LABELS[a.responseStatus] ?? a.responseStatus}</span>}
                  </li>
                ))}
              </ul>
            </div>
          </li>
        ) : (
          event.organizer && (
            <li className="flex gap-3">
              <User className="mt-0.5 size-4 shrink-0 text-zinc-400" /> Organized by {event.organizer.name ?? event.organizer.email}
            </li>
          )
        )}
      </ul>
      {event.htmlLink && (
        <DialogFooter>
          <Button asChild variant="secondary">
            <a href={event.htmlLink} target="_blank" rel="noopener noreferrer">
              Open in Google Calendar <ExternalLink />
            </a>
          </Button>
        </DialogFooter>
      )}
    </DialogContent>
  );
}
