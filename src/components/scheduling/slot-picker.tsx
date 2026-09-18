'use client';

import { DateTime } from 'luxon';
import { ChevronLeft, ChevronRight, CalendarX2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { TimezoneSelect } from './timezone-select';

export interface Slot {
  start: string;
  end: string;
}

export type FetchSlots = (range: { start: Date; end: Date }, signal: AbortSignal) => Promise<{ slots: Slot[] }>;

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Calendar + time-slot picker. Availability always comes from the server for the visible month
 * (in the viewer's chosen time zone); this component only groups and displays it.
 */
export function SlotPicker({
  fetchSlots,
  timezone,
  onTimezoneChange,
  onConfirm,
  confirmLabel = 'Next',
  accent = '#0e7c66',
  maxDaysAhead,
  initialMonth,
  disabledSlot,
  compact = false,
}: {
  fetchSlots: FetchSlots;
  timezone: string;
  onTimezoneChange: (zone: string) => void;
  onConfirm: (slot: Slot) => void;
  confirmLabel?: string;
  accent?: string;
  maxDaysAhead?: number | null;
  initialMonth?: string;
  /** e.g. the interview's current time when rescheduling. */
  disabledSlot?: string | null;
  compact?: boolean;
}) {
  const today = useMemo(() => DateTime.now().setZone(timezone).startOf('day'), [timezone]);
  const [month, setMonth] = useState(() => (initialMonth ? DateTime.fromISO(initialMonth, { zone: timezone }) : DateTime.now().setZone(timezone)).startOf('month'));
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [error, setError] = useState<{ message: string; code: string } | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [pendingSlot, setPendingSlot] = useState<string | null>(null);
  const [hour12, setHour12] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const autoAdvance = useRef(0);

  // Keep the visible month anchored when the zone changes.
  useEffect(() => {
    setMonth((m) => DateTime.fromObject({ year: m.year, month: m.month, day: 1 }, { zone: timezone }));
    setSelectedDate(null);
    setPendingSlot(null);
  }, [timezone]);

  const lastDay = maxDaysAhead ? today.plus({ days: maxDaysAhead + 1 }) : null;
  const canGoBack = month > today.startOf('month');
  const canGoForward = !lastDay || month.plus({ months: 1 }) < lastDay;

  const load = useCallback(
    (signal: AbortSignal) => {
      setSlots(null);
      setError(null);
      const start = month.startOf('month');
      const end = start.plus({ months: 1 });
      return fetchSlots({ start: start.toJSDate(), end: end.toJSDate() }, signal)
        .then((r) => {
          if (signal.aborted) return;
          setSlots(r.slots);
        })
        .catch((err) => {
          if (signal.aborted) return;
          if (err instanceof ApiError) setError({ message: err.message, code: err.code });
          else setError({ message: 'We couldn’t load availability. Please try again.', code: 'NETWORK' });
        });
    },
    [fetchSlots, month],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load, reloadKey]);

  const byDate = useMemo(() => {
    const map = new Map<string, Slot[]>();
    for (const s of slots ?? []) {
      const d = DateTime.fromISO(s.start, { zone: timezone }).toISODate()!;
      const list = map.get(d) ?? [];
      list.push(s);
      map.set(d, list);
    }
    return map;
  }, [slots, timezone]);

  // Auto-select the first available day; if the month is empty, advance (at most twice).
  useEffect(() => {
    if (!slots) return;
    if (selectedDate && byDate.has(selectedDate)) return;
    const first = [...byDate.keys()].sort()[0];
    if (first) {
      setSelectedDate(first);
      autoAdvance.current = 0;
    } else {
      setSelectedDate(null);
      if (autoAdvance.current < 2 && canGoForward && !error) {
        autoAdvance.current += 1;
        setMonth((m) => m.plus({ months: 1 }));
      }
    }
  }, [slots, byDate, selectedDate, canGoForward, error]);

  const gridStart = month.startOf('month').minus({ days: month.startOf('month').weekday - 1 });
  const days = Array.from({ length: 42 }, (_, i) => gridStart.plus({ days: i }));
  const trimmed = days[35].month !== month.month ? days.slice(0, 35) : days;
  const daySlots = selectedDate ? (byDate.get(selectedDate) ?? []) : [];

  return (
    <div className={cn('grid gap-6', compact ? 'md:grid-cols-[1fr_200px]' : 'md:grid-cols-[1fr_220px]')}>
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-[15px] font-semibold text-zinc-900" aria-live="polite">
            {month.toFormat('LLLL yyyy')}
          </h3>
          <div className="flex gap-1">
            <Button variant="ghost" size="icon-sm" disabled={!canGoBack} onClick={() => { autoAdvance.current = 3; setMonth((m) => m.minus({ months: 1 })); }} aria-label="Previous month">
              <ChevronLeft />
            </Button>
            <Button variant="ghost" size="icon-sm" disabled={!canGoForward} onClick={() => { autoAdvance.current = 3; setMonth((m) => m.plus({ months: 1 })); }} aria-label="Next month">
              <ChevronRight />
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center" role="grid" aria-label="Choose a date">
          {WEEKDAYS.map((d) => (
            <div key={d} className="pb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
              {d}
            </div>
          ))}
          {trimmed.map((day) => {
            const iso = day.toISODate()!;
            const inMonth = day.month === month.month;
            const available = inMonth && byDate.has(iso);
            const selected = iso === selectedDate;
            const isToday = day.hasSame(today, 'day');
            if (!inMonth) return <div key={iso} aria-hidden="true" />;
            return (
              <button
                key={iso}
                type="button"
                disabled={!available}
                onClick={() => {
                  setSelectedDate(iso);
                  setPendingSlot(null);
                }}
                aria-pressed={selected}
                aria-label={`${day.toFormat('cccc, LLLL d')}${available ? `, ${byDate.get(iso)!.length} times available` : ', unavailable'}`}
                className={cn(
                  'relative mx-auto flex aspect-square w-full max-w-11 items-center justify-center rounded-full text-sm transition',
                  available && !selected && 'font-semibold hover:brightness-95',
                  !available && 'cursor-default text-zinc-300',
                  selected && 'font-semibold text-white',
                )}
                style={
                  selected
                    ? { backgroundColor: accent }
                    : available
                      ? { backgroundColor: `${accent}14`, color: accent }
                      : undefined
                }
              >
                {day.day}
                {isToday && <span className="absolute bottom-1 size-1 rounded-full" style={{ backgroundColor: selected ? '#fff' : accent }} />}
              </button>
            );
          })}
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-100 pt-4">
          <TimezoneSelect value={timezone} onChange={onTimezoneChange} variant="inline" className="-ml-1.5 max-w-full" />
          <div className="inline-flex rounded-md bg-zinc-100 p-0.5 text-xs">
            {[true, false].map((h) => (
              <button
                key={String(h)}
                type="button"
                onClick={() => setHour12(h)}
                className={cn('rounded px-2 py-0.5 font-medium', hour12 === h ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500')}
              >
                {h ? 'am/pm' : '24h'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="min-h-[280px] md:border-l md:border-zinc-100 md:pl-6">
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 py-8 text-center">
            <CalendarX2 className="size-8 text-zinc-300" />
            <p className="text-sm text-zinc-600">{error.message}</p>
            <Button variant="secondary" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
              <RefreshCw /> Try again
            </Button>
          </div>
        ) : slots === null ? (
          <div className="space-y-2">
            <Skeleton className="mb-4 h-5 w-32" />
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full rounded-lg" />
            ))}
          </div>
        ) : !selectedDate ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-8 text-center">
            <CalendarX2 className="size-8 text-zinc-300" />
            <p className="text-sm font-medium text-zinc-700">No times available in {month.toFormat('LLLL')}</p>
            {canGoForward && (
              <Button variant="link" size="sm" onClick={() => { autoAdvance.current = 0; setMonth((m) => m.plus({ months: 1 })); }}>
                Check next month
              </Button>
            )}
          </div>
        ) : (
          <div>
            <p className="mb-3 text-sm font-semibold text-zinc-900">{DateTime.fromISO(selectedDate, { zone: timezone }).toFormat('cccc, LLLL d')}</p>
            <div className="scrollbar-thin max-h-[360px] space-y-2 overflow-y-auto pr-1" role="listbox" aria-label="Available times">
              {daySlots.map((s) => {
                const label = DateTime.fromISO(s.start, { zone: timezone }).toFormat(hour12 ? 'h:mm a' : 'HH:mm');
                const isPending = pendingSlot === s.start;
                const isCurrent = disabledSlot === s.start;
                return (
                  <div key={s.start} className="flex gap-2">
                    <button
                      type="button"
                      role="option"
                      aria-selected={isPending}
                      disabled={isCurrent}
                      onClick={() => setPendingSlot(isPending ? null : s.start)}
                      className={cn(
                        'h-11 flex-1 rounded-lg border text-sm font-semibold transition tabular',
                        isPending ? 'border-zinc-700 bg-zinc-700 text-white' : 'bg-white hover:border-2',
                        isCurrent && 'cursor-not-allowed opacity-40',
                      )}
                      style={isPending ? undefined : { borderColor: `${accent}66`, color: accent }}
                    >
                      {label}
                      {isCurrent && <span className="ml-1 text-xs font-normal">(current)</span>}
                    </button>
                    {isPending && (
                      <button
                        type="button"
                        onClick={() => onConfirm(s)}
                        className="h-11 flex-1 animate-fade-in rounded-lg text-sm font-semibold text-white"
                        style={{ backgroundColor: accent }}
                        autoFocus
                      >
                        {confirmLabel}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
