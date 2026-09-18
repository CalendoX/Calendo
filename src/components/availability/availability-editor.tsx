'use client';

import { DateTime } from 'luxon';
import { CalendarOff, Copy, Plus, Star, Trash2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { TimezoneSelect } from '@/components/scheduling/timezone-select';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api, ApiError, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';

interface Interval {
  start: string;
  end: string;
}
export interface ScheduleValue {
  id: string;
  name: string;
  timezone: string;
  isDefault: boolean;
  weekly: { weekday: number; intervals: Interval[] }[];
  overrides: { date: string; intervals: Interval[]; note: string | null }[];
  eventTypeCount: number;
}

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function toMin(t: string) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function fromMin(m: number) {
  const c = Math.min(m, 1440);
  return `${String(Math.floor(c / 60)).padStart(2, '0')}:${String(c % 60).padStart(2, '0')}`;
}
function nextInterval(list: Interval[]): Interval {
  const last = list[list.length - 1];
  if (!last) return { start: '09:00', end: '17:00' };
  const s = Math.min(toMin(last.end) + 60, 23 * 60);
  return { start: fromMin(s), end: fromMin(Math.min(s + 60, 1440)) };
}
function intervalErrors(list: Interval[]) {
  const sorted = [...list].map((i) => ({ s: toMin(i.start), e: i.end === '24:00' ? 1440 : toMin(i.end) })).sort((a, b) => a.s - b.s);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].e <= sorted[i].s) return 'End time must be after start time';
    if (sorted[i + 1] && sorted[i + 1].s < sorted[i].e) return 'Time ranges overlap';
  }
  return null;
}

function IntervalRows({ intervals, onChange }: { intervals: Interval[]; onChange: (next: Interval[]) => void }) {
  return (
    <div className="space-y-2">
      {intervals.map((iv, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <Input type="time" step={900} aria-label="Start time" className="w-[118px]" value={iv.start} onChange={(e) => onChange(intervals.map((x, i) => (i === idx ? { ...x, start: e.target.value } : x)))} />
          <span className="text-zinc-400">–</span>
          <Input type="time" step={900} aria-label="End time" className="w-[118px]" value={iv.end === '24:00' ? '23:59' : iv.end} onChange={(e) => onChange(intervals.map((x, i) => (i === idx ? { ...x, end: e.target.value === '23:59' ? '24:00' : e.target.value } : x)))} />
          <Button variant="ghost" size="icon-sm" aria-label="Remove time range" onClick={() => onChange(intervals.filter((_, i) => i !== idx))}>
            <X />
          </Button>
        </div>
      ))}
    </div>
  );
}

export function AvailabilityEditor({ schedule, viewerTimezone }: { schedule: ScheduleValue; viewerTimezone: string }) {
  const router = useRouter();
  const [v, setV] = useState(schedule);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});

  const update = (patch: Partial<ScheduleValue>) => {
    setV((p) => ({ ...p, ...patch }));
    setDirty(true);
  };
  const setDay = (weekday: number, intervals: Interval[]) => update({ weekly: v.weekly.map((d) => (d.weekday === weekday ? { ...d, intervals } : d)) });
  const dayErrors = useMemo(() => Object.fromEntries(v.weekly.map((d) => [d.weekday, intervalErrors(d.intervals)])), [v.weekly]);
  const hasErrors = Object.values(dayErrors).some(Boolean);
  const upcomingOverrides = v.overrides.filter((o) => o.date >= DateTime.now().setZone(v.timezone).toISODate()!).sort((a, b) => a.date.localeCompare(b.date));

  async function save() {
    setBusy(true);
    setServerErrors({});
    try {
      await api(`/api/availability/${v.id}`, { method: 'PUT', body: { name: v.name, timezone: v.timezone, weekly: v.weekly, overrides: v.overrides.map((o) => ({ ...o, note: o.note || null })) } });
      toast.success('Availability saved');
      setDirty(false);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) setServerErrors(err.fieldErrors);
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardBody className="flex flex-wrap items-end gap-4">
          <Field label="Schedule name" htmlFor="sched-name" className="min-w-[220px] flex-1">
            <Input id="sched-name" value={v.name} onChange={(e) => update({ name: e.target.value })} />
          </Field>
          <Field label="Time zone" className="min-w-[260px] flex-1">
            <TimezoneSelect value={v.timezone} onChange={(tz) => update({ timezone: tz })} />
          </Field>
          <div className="flex items-center gap-2 pb-0.5">
            {v.isDefault ? (
              <Badge tone="brand">
                <Star className="size-3" /> Default
              </Badge>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => {
                  try {
                    await api(`/api/availability/${v.id}/default`, { body: {} });
                    toast.success(`${v.name} is now your default schedule`);
                    router.refresh();
                  } catch (err) {
                    toast.error(errorMessage(err));
                  }
                }}
              >
                <Star /> Make default
              </Button>
            )}
            {!v.isDefault && (
              <Button variant="ghost" size="icon-sm" aria-label="Delete schedule" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="text-rose-500" />
              </Button>
            )}
          </div>
        </CardBody>
      </Card>
      {v.timezone !== viewerTimezone && (
        <Alert tone="info">
          Hours below are in <strong>{v.timezone.replace(/_/g, ' ')}</strong>. Candidates always see times converted to their own time zone.
        </Alert>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader title="Weekly hours" description="Set the times you’re available for interviews each week." />
          <ul className="divide-y divide-zinc-100">
            {v.weekly.map((day) => {
              const enabled = day.intervals.length > 0;
              return (
                <li key={day.weekday} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start">
                  <label className="flex w-40 shrink-0 items-center gap-3 pt-1.5">
                    <Switch checked={enabled} onCheckedChange={(c) => setDay(day.weekday, c ? [{ start: '09:00', end: '17:00' }] : [])} aria-label={`${DAY_NAMES[day.weekday - 1]} available`} />
                    <span className={cn('text-sm font-medium', enabled ? 'text-zinc-900' : 'text-zinc-400')}>{DAY_NAMES[day.weekday - 1]}</span>
                  </label>
                  <div className="min-w-0 flex-1">
                    {enabled ? (
                      <>
                        <IntervalRows intervals={day.intervals} onChange={(next) => setDay(day.weekday, next)} />
                        {(dayErrors[day.weekday] || serverErrors[`weekly.${day.weekday}`]) && <p className="mt-1.5 text-xs font-medium text-rose-600">{dayErrors[day.weekday] ?? serverErrors[`weekly.${day.weekday}`]}</p>}
                      </>
                    ) : (
                      <p className="pt-2 text-sm text-zinc-400">Unavailable</p>
                    )}
                  </div>
                  {enabled && (
                    <div className="flex gap-1 sm:pt-0.5">
                      <Button variant="ghost" size="icon-sm" aria-label="Add time range" onClick={() => setDay(day.weekday, [...day.intervals, nextInterval(day.intervals)])}>
                        <Plus />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Copy to all weekdays"
                        title="Copy these hours to Monday–Friday"
                        onClick={() => {
                          update({ weekly: v.weekly.map((d) => (d.weekday <= 5 ? { ...d, intervals: day.intervals.map((i) => ({ ...i })) } : d)) });
                          toast.success('Copied to Monday–Friday');
                        }}
                      >
                        <Copy />
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>

        <Card className="h-fit">
          <CardHeader
            title="Date overrides"
            description="Change hours for specific dates or block out time off."
            action={
              <Button variant="secondary" size="sm" onClick={() => setOverrideOpen(true)}>
                <Plus /> Add
              </Button>
            }
          />
          {upcomingOverrides.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-zinc-500">
              <CalendarOff className="mx-auto mb-2 size-6 text-zinc-300" />
              No upcoming overrides.
            </div>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {upcomingOverrides.map((o) => (
                <li key={o.date} className="flex items-start justify-between gap-3 px-5 py-3">
                  <div>
                    <p className="text-sm font-medium text-zinc-900">{DateTime.fromISO(o.date).toFormat('ccc, LLL d, yyyy')}</p>
                    <p className="text-xs text-zinc-500">{o.intervals.length === 0 ? 'Unavailable all day' : o.intervals.map((i) => `${i.start}–${i.end}`).join(', ')}</p>
                    {o.note && <p className="text-xs text-zinc-400">{o.note}</p>}
                  </div>
                  <Button variant="ghost" size="icon-sm" aria-label="Remove override" onClick={() => update({ overrides: v.overrides.filter((x) => x.date !== o.date) })}>
                    <Trash2 className="text-zinc-400" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="sticky bottom-4 z-10 flex justify-end">
        <div className={cn('flex items-center gap-3 rounded-xl border bg-white px-4 py-2.5 shadow-pop transition', dirty ? 'border-brand-200' : 'border-zinc-200')}>
          <span className="text-sm text-zinc-500">{dirty ? 'You have unsaved changes' : 'All changes saved'}</span>
          <Button onClick={save} loading={busy} disabled={!dirty || hasErrors}>
            Save availability
          </Button>
        </div>
      </div>

      <OverrideDialog
        open={overrideOpen}
        onOpenChange={setOverrideOpen}
        timezone={v.timezone}
        onAdd={(o) => {
          update({ overrides: [...v.overrides.filter((x) => !o.dates.includes(x.date)), ...o.dates.map((date) => ({ date, intervals: o.intervals, note: o.note }))] });
          setOverrideOpen(false);
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${v.name}”?`}
        description={v.eventTypeCount ? `${v.eventTypeCount} event type(s) use this schedule and will fall back to your default schedule.` : 'This cannot be undone.'}
        confirmLabel="Delete schedule"
        onConfirm={async () => {
          try {
            await api(`/api/availability/${v.id}`, { method: 'DELETE' });
            toast.success('Schedule deleted');
            router.push('/availability');
            router.refresh();
          } catch (err) {
            toast.error(errorMessage(err));
          }
        }}
      />
    </div>
  );
}

function OverrideDialog({ open, onOpenChange, timezone, onAdd }: { open: boolean; onOpenChange: (o: boolean) => void; timezone: string; onAdd: (o: { dates: string[]; intervals: Interval[]; note: string | null }) => void }) {
  const today = DateTime.now().setZone(timezone).toISODate()!;
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [unavailable, setUnavailable] = useState(true);
  const [intervals, setIntervals] = useState<Interval[]>([{ start: '09:00', end: '12:00' }]);
  const [note, setNote] = useState('');
  const days = useMemo(() => {
    const a = DateTime.fromISO(from);
    const b = DateTime.fromISO(to < from ? from : to);
    const out: string[] = [];
    for (let d = a; d <= b && out.length < 60; d = d.plus({ days: 1 })) out.push(d.toISODate()!);
    return out;
  }, [from, to]);
  const err = unavailable ? null : intervalErrors(intervals);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add date override" description="Applies to the selected dates only, replacing your weekly hours.">
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="From" htmlFor="ov-from">
              <Input id="ov-from" type="date" min={today} value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value); }} />
            </Field>
            <Field label="To" htmlFor="ov-to" hint={`${days.length} day${days.length === 1 ? '' : 's'}`}>
              <Input id="ov-to" type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>
          <label className="flex items-center gap-3 text-sm font-medium text-zinc-800">
            <Switch checked={unavailable} onCheckedChange={setUnavailable} /> Unavailable all day (vacation, holiday)
          </label>
          {!unavailable && (
            <div>
              <IntervalRows intervals={intervals} onChange={setIntervals} />
              <Button variant="ghost" size="sm" className="mt-2" onClick={() => setIntervals([...intervals, nextInterval(intervals)])}>
                <Plus /> Add time range
              </Button>
              {err && <p className="mt-1 text-xs font-medium text-rose-600">{err}</p>}
            </div>
          )}
          <Field label="Note" htmlFor="ov-note" optionalTag>
            <Input id="ov-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Conference" maxLength={200} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={Boolean(err) || (!unavailable && intervals.length === 0)} onClick={() => onAdd({ dates: days, intervals: unavailable ? [] : intervals, note: note || null })}>
            Add override
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function NewScheduleButton({ timezone, copyFromId }: { timezone: string; copyFromId?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Plus /> New schedule
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="New availability schedule" description="Use separate schedules for different interview types, e.g. “Onsite loops” or “Evening screens”." size="sm">
          <Field label="Name" htmlFor="new-sched">
            <Input id="new-sched" value={name} onChange={(e) => setName(e.target.value)} placeholder="Evening screens" autoFocus />
          </Field>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={!name.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  const res = await api<{ id: string }>('/api/availability', { body: { name, timezone, copyFromId: copyFromId ?? null } });
                  setOpen(false);
                  router.push(`/availability?id=${res.id}`);
                  router.refresh();
                } catch (err) {
                  toast.error(errorMessage(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
