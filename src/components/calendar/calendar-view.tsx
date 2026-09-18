'use client';

import { DateTime } from 'luxon';
import { ArrowRight, ChevronLeft, ChevronRight, Clock, Globe2, User, Video } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

type View = 'month' | 'week' | 'day';

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

const HOUR_PX = 52;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function rangeFor(view: View, cursor: DateTime) {
  if (view === 'month') {
    const first = cursor.startOf('month');
    const start = first.minus({ days: first.weekday - 1 });
    return { start, end: start.plus({ weeks: 6 }) };
  }
  if (view === 'week') {
    const start = cursor.startOf('week');
    return { start, end: start.plus({ weeks: 1 }) };
  }
  const start = cursor.startOf('day');
  return { start, end: start.plus({ days: 1 }) };
}

/** Assigns side-by-side lanes to overlapping events within one day column. */
function layoutDay(items: { item: CalItem; start: number; end: number }[]) {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: { item: CalItem; start: number; end: number; lane: number; lanes: number }[] = [];
  let cluster: typeof out = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((c) => c.lane + 1));
    cluster.forEach((c) => (c.lanes = lanes));
    out.push(...cluster);
    cluster = [];
  };
  for (const ev of sorted) {
    if (ev.start >= clusterEnd && cluster.length) flush();
    const used = new Set(cluster.filter((c) => c.end > ev.start).map((c) => c.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    cluster.push({ ...ev, lane, lanes: 1 });
    clusterEnd = Math.max(clusterEnd, ev.end);
  }
  if (cluster.length) flush();
  return out;
}

export function CalendarView({
  scope,
  timezone,
  showInterviewer,
  interviewers = [],
  defaultView = 'week',
}: {
  scope: 'mine' | 'team';
  timezone: string;
  showInterviewer: boolean;
  interviewers?: { id: string; name: string }[];
  defaultView?: View;
}) {
  const [view, setView] = useState<View>(defaultView);
  const [cursor, setCursor] = useState<DateTime>(() => DateTime.now().setZone(timezone));
  const [items, setItems] = useState<CalItem[] | null>(null);
  const [busy, setBusy] = useState<{ start: string; end: string }[]>([]);
  const [busyState, setBusyState] = useState<'none' | 'ok' | 'unavailable'>('none');
  const [error, setError] = useState<string | null>(null);
  const [interviewerId, setInterviewerId] = useState('');
  const [showCancelled, setShowCancelled] = useState(false);
  const [selected, setSelected] = useState<CalItem | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const range = useMemo(() => rangeFor(view, cursor), [view, cursor]);
  const now = DateTime.now().setZone(timezone);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setError(null);
      const qs = new URLSearchParams({ start: range.start.toUTC().toISO()!, end: range.end.toUTC().toISO()!, scope });
      if (interviewerId) qs.set('interviewerId', interviewerId);
      if (showCancelled) qs.set('includeCancelled', 'true');
      try {
        const res = await api<{ items: CalItem[] }>(`/api/calendar/events?${qs}`, { signal });
        setItems(res.items);
      } catch (err) {
        if (!signal.aborted) setError(errorMessage(err, 'Could not load interviews.'));
      }
      if (view !== 'month' && scope === 'mine') {
        try {
          const b = await api<{ connected: boolean; available: boolean; busy: { start: string; end: string }[] }>(
            `/api/calendar/busy?start=${encodeURIComponent(range.start.toUTC().toISO()!)}&end=${encodeURIComponent(range.end.toUTC().toISO()!)}`,
            { signal },
          );
          setBusy(b.busy);
          setBusyState(!b.connected ? 'none' : b.available ? 'ok' : 'unavailable');
        } catch {
          setBusy([]);
        }
      } else {
        setBusy([]);
        setBusyState('none');
      }
    },
    [range, scope, interviewerId, showCancelled, view],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    setItems(null);
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  useEffect(() => {
    if (view !== 'month' && scrollRef.current) scrollRef.current.scrollTop = HOUR_PX * 7.5;
  }, [view]);

  const step = (dir: 1 | -1) => setCursor((c) => c.plus(view === 'month' ? { months: dir } : view === 'week' ? { weeks: dir } : { days: dir }));
  const title =
    view === 'month'
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

  const days = view === 'week' ? Array.from({ length: 7 }, (_, i) => range.start.plus({ days: i })) : [range.start];

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-100 px-4 py-3">
        <div className="flex items-center gap-1">
          <Button variant="secondary" size="sm" onClick={() => setCursor(DateTime.now().setZone(timezone))}>
            Today
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => step(-1)} aria-label="Previous">
            <ChevronLeft />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => step(1)} aria-label="Next">
            <ChevronRight />
          </Button>
        </div>
        <h2 className="text-base font-semibold text-zinc-900" aria-live="polite">
          {title}
        </h2>
        {items === null && <Spinner className="text-zinc-400" />}
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
            ]}
          />
        </div>
      </div>
      {error && <p className="border-b border-rose-100 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</p>}

      {view === 'month' ? (
        <div className="grid grid-cols-7">
          {WEEKDAYS.map((d) => (
            <div key={d} className="border-b border-zinc-100 px-2 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
              {d}
            </div>
          ))}
          {Array.from({ length: 42 }, (_, i) => range.start.plus({ days: i })).map((day) => {
            const iso = day.toISODate()!;
            const list = byDay.get(iso) ?? [];
            const inMonth = day.month === cursor.month;
            const isToday = day.hasSame(now, 'day');
            return (
              <div key={iso} className={cn('min-h-[112px] border-b border-r border-zinc-100 p-1.5 [&:nth-child(7n)]:border-r-0', !inMonth && 'bg-zinc-50/60')}>
                <button
                  onClick={() => {
                    setCursor(day);
                    setView('day');
                  }}
                  className={cn('mb-1 flex size-6 items-center justify-center rounded-full text-xs font-medium', isToday ? 'bg-brand-600 text-white' : inMonth ? 'text-zinc-700 hover:bg-zinc-100' : 'text-zinc-400')}
                >
                  {day.day}
                </button>
                <div className="space-y-0.5">
                  {list.slice(0, 3).map((i) => (
                    <button
                      key={i.id}
                      onClick={() => setSelected(i)}
                      className={cn('flex w-full items-center gap-1.5 truncate rounded px-1.5 py-0.5 text-left text-xs hover:bg-zinc-100', i.status === 'cancelled' && 'text-zinc-400 line-through')}
                    >
                      <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: i.eventType.color }} />
                      <span className="tabular shrink-0 text-zinc-500">{DateTime.fromISO(i.startAt, { zone: timezone }).toFormat('h:mma').toLowerCase()}</span>
                      <span className="truncate font-medium text-zinc-800">{i.candidate.name}</span>
                    </button>
                  ))}
                  {list.length > 3 && (
                    <button
                      className="px-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-800"
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
      ) : (
        <div className="grid lg:grid-cols-[1fr_280px]">
          <div className="min-w-0 border-zinc-100 lg:border-r">
            <div className="grid border-b border-zinc-100" style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` }}>
              <div />
              {days.map((d) => (
                <div key={d.toISODate()} className="px-2 py-2 text-center">
                  <p className="text-xs font-medium uppercase text-zinc-400">{d.toFormat('ccc')}</p>
                  <p className={cn('mx-auto mt-0.5 flex size-8 items-center justify-center rounded-full text-sm font-semibold', d.hasSame(now, 'day') ? 'bg-brand-600 text-white' : 'text-zinc-800')}>{d.day}</p>
                </div>
              ))}
            </div>
            <div ref={scrollRef} className="scrollbar-thin relative max-h-[640px] overflow-y-auto">
              <div className="grid" style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` }}>
                <div className="relative" style={{ height: HOUR_PX * 24 }}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <span key={h} className="tabular absolute right-2 -translate-y-1/2 text-[11px] text-zinc-400" style={{ top: h * HOUR_PX }}>
                      {h === 0 ? '' : DateTime.fromObject({ hour: h }).toFormat('h a')}
                    </span>
                  ))}
                </div>
                {days.map((d) => {
                  const dayStart = d.startOf('day');
                  const dayEnd = dayStart.plus({ days: 1 });
                  const toPx = (dt: DateTime) => (dt.diff(dayStart, 'minutes').minutes / 60) * HOUR_PX;
                  const events = layoutDay(
                    (byDay.get(d.toISODate()!) ?? []).map((item) => {
                      const s = DateTime.fromISO(item.startAt, { zone: timezone });
                      const e = DateTime.fromISO(item.endAt, { zone: timezone });
                      return { item, start: toPx(s), end: Math.max(toPx(s) + 22, toPx(e < dayEnd ? e : dayEnd)) };
                    }),
                  );
                  const dayBusy = busy
                    .map((b) => ({ s: DateTime.fromISO(b.start, { zone: timezone }), e: DateTime.fromISO(b.end, { zone: timezone }) }))
                    .filter((b) => b.s < dayEnd && b.e > dayStart);
                  return (
                    <div key={d.toISODate()} className="relative border-l border-zinc-100" style={{ height: HOUR_PX * 24 }}>
                      {Array.from({ length: 24 }, (_, h) => (
                        <div key={h} className="absolute inset-x-0 border-t border-zinc-100" style={{ top: h * HOUR_PX }} />
                      ))}
                      {dayBusy.map((b, idx) => {
                        const top = toPx(b.s < dayStart ? dayStart : b.s);
                        const bottom = toPx(b.e > dayEnd ? dayEnd : b.e);
                        return (
                          <div
                            key={idx}
                            className="absolute inset-x-1 rounded-md border border-dashed border-zinc-300 bg-[repeating-linear-gradient(135deg,transparent,transparent_5px,rgba(0,0,0,0.035)_5px,rgba(0,0,0,0.035)_10px)] px-1.5 pt-0.5 text-[10px] font-medium text-zinc-400"
                            style={{ top, height: Math.max(bottom - top, 14) }}
                            title="Busy in Google Calendar"
                          >
                            Busy
                          </div>
                        );
                      })}
                      {events.map(({ item, start, end, lane, lanes }) => (
                        <button
                          key={item.id}
                          onClick={() => setSelected(item)}
                          className={cn(
                            'absolute overflow-hidden rounded-md border-l-[3px] px-1.5 py-1 text-left text-xs shadow-sm ring-1 ring-black/5 transition hover:z-10 hover:shadow-md',
                            item.status === 'cancelled' ? 'bg-zinc-100 text-zinc-400 line-through' : 'bg-white',
                          )}
                          style={{
                            top: start,
                            height: end - start - 2,
                            left: `calc(${(lane / lanes) * 100}% + 3px)`,
                            width: `calc(${100 / lanes}% - 6px)`,
                            borderLeftColor: item.eventType.color,
                            backgroundColor: item.status === 'cancelled' ? undefined : `${item.eventType.color}12`,
                          }}
                        >
                          <span className="block truncate font-semibold text-zinc-900">{item.candidate.name}</span>
                          <span className="tabular block truncate text-zinc-500">
                            {DateTime.fromISO(item.startAt, { zone: timezone }).toFormat('h:mm')} – {DateTime.fromISO(item.endAt, { zone: timezone }).toFormat('h:mm a')}
                          </span>
                          {end - start > 60 && <span className="block truncate text-zinc-500">{item.eventType.name}</span>}
                        </button>
                      ))}
                      {d.hasSame(now, 'day') && (
                        <div className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: toPx(now) }}>
                          <span className="-ml-1 size-2 rounded-full bg-rose-500" />
                          <span className="h-px flex-1 bg-rose-500" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <aside className="hidden border-t border-zinc-100 lg:block lg:border-t-0">
            <div className="border-b border-zinc-100 px-4 py-3">
              <p className="text-sm font-semibold text-zinc-900">{view === 'day' ? 'This day' : 'This week'}</p>
              <p className="text-xs text-zinc-500">
                {(items ?? []).filter((i) => i.status !== 'cancelled').length} interviews · {zoneLabel(timezone)}
              </p>
              {busyState === 'ok' && <p className="mt-1 text-xs text-zinc-400">Striped blocks are busy times from Google Calendar.</p>}
              {busyState === 'unavailable' && <p className="mt-1 text-xs text-amber-700">Google Calendar busy times couldn’t be loaded.</p>}
            </div>
            <ul className="scrollbar-thin max-h-[640px] divide-y divide-zinc-100 overflow-y-auto">
              {(items ?? []).length === 0 && <li className="px-4 py-8 text-center text-sm text-zinc-500">No interviews</li>}
              {(items ?? []).map((i) => (
                <li key={i.id}>
                  <button onClick={() => setSelected(i)} className="flex w-full gap-3 px-4 py-3 text-left hover:bg-zinc-50">
                    <span className="mt-1 h-8 w-1 shrink-0 rounded-full" style={{ backgroundColor: i.eventType.color }} />
                    <span className="min-w-0">
                      <span className={cn('block truncate text-sm font-medium', i.status === 'cancelled' ? 'text-zinc-400 line-through' : 'text-zinc-900')}>{i.candidate.name}</span>
                      <span className="tabular block text-xs text-zinc-500">
                        {DateTime.fromISO(i.startAt, { zone: timezone }).toFormat('ccc d · h:mm a')}
                      </span>
                      <span className="block truncate text-xs text-zinc-400">{i.eventType.name}</span>
                    </span>
                  </button>
                </li>
              ))}
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
    </Card>
  );
}
