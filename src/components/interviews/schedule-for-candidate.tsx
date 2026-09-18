'use client';

import { DateTime } from 'luxon';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { SlotPicker, type FetchSlots, type Slot } from '@/components/scheduling/slot-picker';
import { TimezoneSelect } from '@/components/scheduling/timezone-select';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api, ApiError, errorMessage } from '@/lib/api-client';
import { formatDuration } from '@/lib/format';

interface Option {
  id: string;
  name: string;
  durationMinutes: number;
  host: { name: string };
  isActive: boolean;
}

/** Recruiters/interviewers booking a slot on a candidate's behalf (same engine, same checks). */
export function ScheduleForCandidate({ eventTypes, viewerTimezone }: { eventTypes: Option[]; viewerTimezone: string }) {
  const router = useRouter();
  const [eventTypeId, setEventTypeId] = useState(eventTypes[0]?.id ?? '');
  const [timezone, setTimezone] = useState(viewerTimezone);
  const [candidateTz, setCandidateTz] = useState(viewerTimezone);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [override, setOverride] = useState(false);
  const [customDate, setCustomDate] = useState('');
  const [customTime, setCustomTime] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pickerKey, setPickerKey] = useState(0);
  const selected = eventTypes.find((e) => e.id === eventTypeId);

  const fetchSlots: FetchSlots = useCallback(
    (range, signal) => api(`/api/event-types/${eventTypeId}/availability?start=${encodeURIComponent(range.start.toISOString())}&end=${encodeURIComponent(range.end.toISOString())}`, { signal }),
    [eventTypeId],
  );

  const start = override
    ? customDate && customTime
      ? DateTime.fromISO(`${customDate}T${customTime}`, { zone: timezone })
      : null
    : slot
      ? DateTime.fromISO(slot.start, { zone: timezone })
      : null;

  if (eventTypes.length === 0) {
    return <Alert tone="info" title="No event types yet">Create an event type first — interviews are always booked against one.</Alert>;
  }

  return (
    <form
      className="grid gap-6 xl:grid-cols-[380px_1fr]"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!start?.isValid) {
          setFormError('Choose a time for the interview.');
          return;
        }
        const data = new FormData(e.currentTarget);
        setBusy(true);
        setErrors({});
        setFormError(null);
        try {
          const res = await api<{ interviewId: string }>('/api/interviews', {
            body: {
              eventTypeId,
              start: start.toUTC().toISO(),
              candidate: { name: data.get('name'), email: data.get('email'), phone: data.get('phone') || null, timezone: candidateTz },
              answers: {},
              ignoreWorkingHours: override,
            },
          });
          toast.success('Interview scheduled — the candidate has been emailed');
          router.push(`/interviews/${res.interviewId}`);
        } catch (err) {
          setBusy(false);
          if (err instanceof ApiError) {
            const fe = err.fieldErrors;
            setErrors({ name: fe['candidate.name'], email: fe['candidate.email'], phone: fe['candidate.phone'] ?? fe.phone });
            if (err.code === 'SLOT_UNAVAILABLE') {
              setSlot(null);
              setPickerKey((k) => k + 1);
            }
          }
          setFormError(errorMessage(err));
        }
      }}
    >
      <Card className="h-fit">
        <CardHeader title="Candidate & interview" />
        <CardBody className="space-y-4">
          {formError && <Alert tone="error">{formError}</Alert>}
          <Field label="Interview type" htmlFor="eventTypeId">
            <Select
              id="eventTypeId"
              value={eventTypeId}
              onChange={(e) => {
                setEventTypeId(e.target.value);
                setSlot(null);
                setPickerKey((k) => k + 1);
              }}
            >
              {eventTypes.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} · {formatDuration(e.durationMinutes)} · {e.host.name}
                  {e.isActive ? '' : ' (inactive)'}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Candidate name" htmlFor="name" required error={errors.name}>
            <Input id="name" name="name" required />
          </Field>
          <Field label="Candidate email" htmlFor="email" required error={errors.email} hint="The confirmation and calendar invite are sent here.">
            <Input id="email" name="email" type="email" required />
          </Field>
          <Field label="Phone" htmlFor="phone" optionalTag error={errors.phone}>
            <Input id="phone" name="phone" type="tel" />
          </Field>
          <Field label="Candidate time zone" hint="Used for the times in the candidate’s emails.">
            <TimezoneSelect value={candidateTz} onChange={setCandidateTz} />
          </Field>
          <div className="flex items-start justify-between gap-3 rounded-lg bg-zinc-50 p-3">
            <div>
              <p className="text-sm font-medium text-zinc-800">Custom time</p>
              <p className="text-xs text-zinc-500">Book outside working hours. Conflicts are still prevented.</p>
            </div>
            <Switch checked={override} onCheckedChange={(v) => { setOverride(v); setSlot(null); }} aria-label="Custom time" />
          </div>
          {start?.isValid && (
            <div className="rounded-xl border border-brand-200 bg-brand-50/60 p-3 text-sm">
              <p className="font-semibold text-zinc-900">{start.toFormat('cccc, LLLL d · h:mm a ZZZZ')}</p>
              {selected && <p className="text-xs text-zinc-500">{formatDuration(selected.durationMinutes)} with {selected.host.name}</p>}
            </div>
          )}
          <Button type="submit" className="w-full" loading={busy} disabled={!start?.isValid}>
            Schedule interview
          </Button>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={override ? 'Pick a custom time' : 'Pick an available time'} description="Availability accounts for working hours, existing interviews, buffers and the interviewer’s calendar." />
        <CardBody>
          {override ? (
            <div className="grid max-w-xl gap-4 sm:grid-cols-3">
              <Field label="Date" htmlFor="c-date">
                <Input id="c-date" type="date" value={customDate} onChange={(e) => setCustomDate(e.target.value)} />
              </Field>
              <Field label="Start time" htmlFor="c-time">
                <Input id="c-time" type="time" step={300} value={customTime} onChange={(e) => setCustomTime(e.target.value)} />
              </Field>
              <Field label="Time zone">
                <TimezoneSelect value={timezone} onChange={setTimezone} />
              </Field>
            </div>
          ) : (
            <SlotPicker key={`${eventTypeId}-${pickerKey}`} fetchSlots={fetchSlots} timezone={timezone} onTimezoneChange={setTimezone} onConfirm={setSlot} confirmLabel="Select" />
          )}
        </CardBody>
      </Card>
    </form>
  );
}
