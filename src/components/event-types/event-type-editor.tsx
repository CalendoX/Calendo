'use client';

import { ArrowDown, ArrowUp, Building2, Link2, MapPin, Phone, Plus, Trash2, Video } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api, ApiError, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { formatDuration, formatReminderOffset, slugify } from '@/lib/format';

type FieldMode = 'hidden' | 'optional' | 'required';
type LocationKind = 'zoom' | 'google_meet' | 'phone' | 'in_person' | 'custom';
type QuestionType = 'short_text' | 'long_text' | 'single_select' | 'url';

export interface EventTypeFormValue {
  name: string;
  slug: string;
  description: string;
  color: string;
  durationMinutes: number;
  locationType: LocationKind;
  locationDetails: string;
  hostUserId: string;
  scheduleId: string | null;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minimumNoticeMinutes: number;
  maxDaysInFuture: number | null;
  slotIntervalMinutes: number | null;
  dailyLimit: number | null;
  isActive: boolean;
  visibility: 'public' | 'link_only';
  questions: { id?: string; label: string; type: QuestionType; required: boolean; options?: string[]; helpText?: string }[];
  fieldConfig: { phone: FieldMode; company: FieldMode; linkedinUrl: FieldMode; resumeUrl: FieldMode };
  reminderOffsetsMinutes: number[] | null;
}

const COLORS = ['#0e7c66', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#ca8a04', '#0891b2', '#475569'];
const DURATIONS = [15, 30, 45, 60, 90];
const BUFFERS = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120];
const REMINDER_CHOICES = [10080, 2880, 1440, 240, 120, 60, 30, 15];

function noticeParts(minutes: number): { value: number; unit: 'minutes' | 'hours' | 'days' } {
  if (minutes > 0 && minutes % 1440 === 0) return { value: minutes / 1440, unit: 'days' };
  if (minutes > 0 && minutes % 60 === 0) return { value: minutes / 60, unit: 'hours' };
  return { value: minutes, unit: 'minutes' };
}
const UNIT_MINUTES = { minutes: 1, hours: 60, days: 1440 } as const;

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} description={description} />
      <CardBody className="space-y-5">{children}</CardBody>
    </Card>
  );
}

export function EventTypeEditor({
  mode,
  eventTypeId,
  initial,
  hosts,
  schedules,
  zoomConnectedHostIds,
  canAssignHost,
  orgReminderDefault,
  publicBaseUrl,
}: {
  mode: 'create' | 'edit';
  eventTypeId?: string;
  initial: EventTypeFormValue;
  hosts: { id: string; name: string; username: string }[];
  schedules: { id: string; userId: string; name: string; timezone: string; isDefault: boolean }[];
  zoomConnectedHostIds: string[];
  canAssignHost: boolean;
  orgReminderDefault: number[];
  publicBaseUrl: string;
}) {
  const router = useRouter();
  const [v, setV] = useState<EventTypeFormValue>(initial);
  const [slugTouched, setSlugTouched] = useState(mode === 'edit');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const notice = noticeParts(v.minimumNoticeMinutes);
  const host = hosts.find((h) => h.id === v.hostUserId);
  const hostSchedules = schedules.filter((s) => s.userId === v.hostUserId);
  const defaultSchedule = hostSchedules.find((s) => s.isDefault) ?? hostSchedules[0];
  const effectiveSchedule = hostSchedules.find((s) => s.id === v.scheduleId) ?? defaultSchedule;
  const customDuration = !DURATIONS.includes(v.durationMinutes);

  const set = <K extends keyof EventTypeFormValue>(key: K, value: EventTypeFormValue[K]) => setV((prev) => ({ ...prev, [key]: value }));

  async function save() {
    setBusy(true);
    setErrors({});
    setFormError(null);
    const body = {
      ...v,
      slug: v.slug || undefined,
      description: v.description || null,
      locationDetails: v.locationDetails || null,
      hostUserId: v.hostUserId,
      questions: v.questions.map((q) => ({ ...q, options: q.type === 'single_select' ? (q.options ?? []).map((o) => o.trim()).filter(Boolean) : undefined })),
    };
    try {
      if (mode === 'create') {
        const res = await api<{ id: string }>('/api/event-types', { body });
        toast.success('Event type created');
        router.push(`/event-types/${res.id}?created=1`);
      } else {
        await api(`/api/event-types/${eventTypeId}`, { method: 'PATCH', body });
        toast.success('Changes saved');
        router.refresh();
      }
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      setFormError(errorMessage(err));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setBusy(false);
    }
  }

  const locations: { value: LocationKind; label: string; icon: React.ReactNode; disabled?: boolean; hint?: string }[] = [
    { value: 'zoom', label: 'Zoom', icon: <Video className="size-4" />, hint: 'Meeting created automatically' },
    { value: 'phone', label: 'Phone call', icon: <Phone className="size-4" /> },
    { value: 'in_person', label: 'In person', icon: <Building2 className="size-4" /> },
    { value: 'custom', label: 'Custom', icon: <MapPin className="size-4" /> },
    { value: 'google_meet', label: 'Google Meet', icon: <Video className="size-4" />, disabled: true, hint: 'Coming soon' },
  ];

  return (
    <div className="space-y-6 pb-24">
      {formError && <Alert tone="error">{formError}</Alert>}

      <Section title="Details" description="What candidates see on the booking page.">
        <div className="grid gap-5 md:grid-cols-2">
          <Field label="Name" htmlFor="name" required error={errors.name}>
            <Input
              id="name"
              value={v.name}
              placeholder="Technical Interview"
              onChange={(e) => {
                const name = e.target.value;
                setV((p) => ({ ...p, name, slug: slugTouched ? p.slug : slugify(name) }));
              }}
            />
          </Field>
          <Field label="URL" htmlFor="slug" error={errors.slug} hint={host ? `${publicBaseUrl.replace(/^https?:\/\//, '')}/schedule/${host.username}/${v.slug || '…'}` : undefined}>
            <Input
              id="slug"
              value={v.slug}
              onChange={(e) => {
                setSlugTouched(true);
                set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
              }}
            />
          </Field>
        </div>
        <Field label="Description" htmlFor="description" error={errors.description} hint="Share what the interview covers and how to prepare.">
          <Textarea id="description" rows={4} value={v.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
        <div className="grid gap-5 md:grid-cols-2">
          {canAssignHost && (
            <Field label="Interviewer" htmlFor="host" error={errors.hostUserId}>
              <Select
                id="host"
                value={v.hostUserId}
                onChange={(e) => setV((p) => ({ ...p, hostUserId: e.target.value, scheduleId: null }))}
              >
                {hosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Colour">
            <div className="flex flex-wrap gap-2 pt-1">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Colour ${c}`}
                  aria-pressed={v.color === c}
                  onClick={() => set('color', c)}
                  className={cn('size-7 rounded-full ring-offset-2 transition', v.color === c ? 'ring-2 ring-zinc-900' : 'hover:scale-110')}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </Field>
        </div>
      </Section>

      <Section title="Duration & location">
        <Field label="Duration" error={errors.durationMinutes}>
          <div className="flex flex-wrap items-center gap-2">
            {DURATIONS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => set('durationMinutes', d)}
                className={cn(
                  'h-9 rounded-lg border px-3.5 text-sm font-medium transition',
                  v.durationMinutes === d ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300',
                )}
              >
                {formatDuration(d)}
              </button>
            ))}
            <div className={cn('flex items-center gap-2 rounded-lg border px-2', customDuration ? 'border-brand-600 bg-brand-50' : 'border-zinc-200')}>
              <span className="text-sm text-zinc-500">Custom</span>
              <Input
                type="number"
                min={5}
                max={720}
                step={5}
                aria-label="Custom duration in minutes"
                className="h-8 w-20 border-0 bg-transparent px-1 shadow-none focus:ring-0"
                value={v.durationMinutes}
                onChange={(e) => set('durationMinutes', Math.max(5, Number(e.target.value) || 5))}
              />
              <span className="text-sm text-zinc-500">min</span>
            </div>
          </div>
        </Field>
        <Field label="Location" error={errors.locationType}>
          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {locations.map((l) => (
              <button
                key={l.value}
                type="button"
                disabled={l.disabled}
                onClick={() => set('locationType', l.value)}
                className={cn(
                  'flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50',
                  v.locationType === l.value ? 'border-brand-600 bg-brand-50/60 ring-1 ring-brand-600' : 'border-zinc-200 hover:border-zinc-300',
                )}
              >
                <span className={cn('flex items-center gap-2 text-sm font-medium', v.locationType === l.value ? 'text-brand-800' : 'text-zinc-800')}>
                  {l.icon} {l.label}
                </span>
                {l.hint && <span className="text-xs text-zinc-500">{l.hint}</span>}
              </button>
            ))}
          </div>
        </Field>
        {v.locationType === 'zoom' && !zoomConnectedHostIds.includes(v.hostUserId) && (
          <Alert tone="warning" title={`${host?.id === hosts[0]?.id && !canAssignHost ? 'Zoom isn’t connected' : `Zoom isn’t connected for ${host?.name ?? 'this interviewer'}`}`}>
            Interviews can still be booked, but no meeting link will be created until Zoom is connected on the Integrations page. Existing bookings are updated automatically once it is.
          </Alert>
        )}
        {(v.locationType === 'phone' || v.locationType === 'in_person' || v.locationType === 'custom') && (
          <Field
            label={v.locationType === 'phone' ? 'Phone number' : v.locationType === 'in_person' ? 'Address' : 'Location details'}
            htmlFor="locationDetails"
            required
            error={errors.locationDetails}
            hint={v.locationType === 'phone' ? 'The number the candidate should call (or say “We’ll call you”).' : undefined}
          >
            <Input id="locationDetails" value={v.locationDetails} onChange={(e) => set('locationDetails', e.target.value)} />
          </Field>
        )}
      </Section>

      <Section title="Availability & limits" description="How and when this interview can be booked.">
        <div className="grid gap-5 md:grid-cols-2">
          <Field
            label="Availability schedule"
            htmlFor="scheduleId"
            error={errors.scheduleId}
            hint={effectiveSchedule ? `Times are defined in ${effectiveSchedule.timezone.replace(/_/g, ' ')}.` : 'This interviewer has no schedule yet.'}
          >
            <Select id="scheduleId" value={v.scheduleId ?? ''} onChange={(e) => set('scheduleId', e.target.value || null)}>
              <option value="">Default{defaultSchedule ? ` — ${defaultSchedule.name}` : ''}</option>
              {hostSchedules.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.timezone.replace(/_/g, ' ')})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Start times every" htmlFor="slotInterval" hint="Spacing between the times offered to candidates.">
            <Select id="slotInterval" value={v.slotIntervalMinutes ?? ''} onChange={(e) => set('slotIntervalMinutes', e.target.value ? Number(e.target.value) : null)}>
              <option value="">Automatic ({formatDuration(Math.min(v.durationMinutes, 30))})</option>
              {[10, 15, 20, 30, 45, 60, 90, 120].map((m) => (
                <option key={m} value={m}>
                  {formatDuration(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Minimum notice" error={errors.minimumNoticeMinutes} hint="Candidates can’t book closer to the start than this.">
            <div className="flex gap-2">
              <Input type="number" min={0} className="w-24" aria-label="Minimum notice amount" value={notice.value} onChange={(e) => set('minimumNoticeMinutes', Math.max(0, Number(e.target.value) || 0) * UNIT_MINUTES[notice.unit])} />
              <Select aria-label="Minimum notice unit" className="w-32" value={notice.unit} onChange={(e) => set('minimumNoticeMinutes', notice.value * UNIT_MINUTES[e.target.value as keyof typeof UNIT_MINUTES])}>
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </Select>
            </div>
          </Field>
          <Field label="Booking window" error={errors.maxDaysInFuture} hint="How far into the future candidates can book.">
            <div className="flex items-center gap-2">
              <Input type="number" min={1} max={730} className="w-24" aria-label="Days into the future" disabled={v.maxDaysInFuture === null} value={v.maxDaysInFuture ?? ''} onChange={(e) => set('maxDaysInFuture', Math.max(1, Number(e.target.value) || 1))} />
              <span className="text-sm text-zinc-600">days</span>
              <label className="ml-2 flex items-center gap-2 text-sm text-zinc-600">
                <input type="checkbox" className="size-4 accent-brand-600" checked={v.maxDaysInFuture === null} onChange={(e) => set('maxDaysInFuture', e.target.checked ? null : 60)} />
                No limit
              </label>
            </div>
          </Field>
          <Field label="Buffer before" htmlFor="bufferBefore" hint="Free time required before the interview.">
            <Select id="bufferBefore" value={v.bufferBeforeMinutes} onChange={(e) => set('bufferBeforeMinutes', Number(e.target.value))}>
              {BUFFERS.map((b) => (
                <option key={b} value={b}>
                  {b === 0 ? 'No buffer' : formatDuration(b)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Buffer after" htmlFor="bufferAfter" hint="Free time required after the interview.">
            <Select id="bufferAfter" value={v.bufferAfterMinutes} onChange={(e) => set('bufferAfterMinutes', Number(e.target.value))}>
              {BUFFERS.map((b) => (
                <option key={b} value={b}>
                  {b === 0 ? 'No buffer' : formatDuration(b)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Daily limit" htmlFor="dailyLimit" optionalTag hint="Maximum interviews per day for this interviewer.">
            <Input id="dailyLimit" type="number" min={1} max={50} placeholder="Unlimited" value={v.dailyLimit ?? ''} onChange={(e) => set('dailyLimit', e.target.value ? Math.max(1, Number(e.target.value)) : null)} />
          </Field>
        </div>
      </Section>

      <Section title="Booking form" description="Name and email are always required.">
        <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200">
          {(
            [
              ['phone', 'Phone number'],
              ['company', 'Current company'],
              ['linkedinUrl', 'LinkedIn profile'],
              ['resumeUrl', 'Résumé link'],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
              <span className="text-sm font-medium text-zinc-800">{label}</span>
              <div className="inline-flex rounded-lg bg-zinc-100 p-0.5 text-xs">
                {(['hidden', 'optional', 'required'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => set('fieldConfig', { ...v.fieldConfig, [key]: m })}
                    className={cn('rounded-md px-2.5 py-1 font-medium capitalize', v.fieldConfig[key] === m ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500')}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div>
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-medium text-zinc-800">Custom questions</p>
            <Button
              variant="secondary"
              size="sm"
              disabled={v.questions.length >= 10}
              onClick={() => set('questions', [...v.questions, { label: '', type: 'short_text', required: false }])}
            >
              <Plus /> Add question
            </Button>
          </div>
          {v.questions.length === 0 && <p className="rounded-xl border border-dashed border-zinc-200 px-4 py-6 text-center text-sm text-zinc-500">No custom questions. Add one to ask about notice period, visa status, etc.</p>}
          <div className="space-y-3">
            {v.questions.map((q, idx) => (
              <div key={idx} className="rounded-xl border border-zinc-200 p-4">
                <div className="grid gap-3 md:grid-cols-[1fr_170px]">
                  <Field label={`Question ${idx + 1}`} error={errors[`questions.${idx}.label`]}>
                    <Input value={q.label} placeholder="What is your notice period?" onChange={(e) => set('questions', v.questions.map((x, i) => (i === idx ? { ...x, label: e.target.value } : x)))} />
                  </Field>
                  <Field label="Answer type">
                    <Select value={q.type} onChange={(e) => set('questions', v.questions.map((x, i) => (i === idx ? { ...x, type: e.target.value as QuestionType } : x)))}>
                      <option value="short_text">Short text</option>
                      <option value="long_text">Paragraph</option>
                      <option value="single_select">Multiple choice</option>
                      <option value="url">Link</option>
                    </Select>
                  </Field>
                </div>
                {q.type === 'single_select' && (
                  <Field label="Options (one per line)" className="mt-3" error={errors[`questions.${idx}.options`]}>
                    <Textarea rows={3} value={(q.options ?? []).join('\n')} onChange={(e) => set('questions', v.questions.map((x, i) => (i === idx ? { ...x, options: e.target.value.split('\n') } : x)))} />
                  </Field>
                )}
                <div className="mt-3 flex items-center justify-between">
                  <label className="flex items-center gap-2 text-sm text-zinc-700">
                    <Switch checked={q.required} onCheckedChange={(c) => set('questions', v.questions.map((x, i) => (i === idx ? { ...x, required: c } : x)))} /> Required
                  </label>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon-sm" aria-label="Move up" disabled={idx === 0} onClick={() => set('questions', v.questions.map((x, i, arr) => (i === idx - 1 ? arr[idx] : i === idx ? arr[idx - 1] : x)))}>
                      <ArrowUp />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label="Move down" disabled={idx === v.questions.length - 1} onClick={() => set('questions', v.questions.map((x, i, arr) => (i === idx + 1 ? arr[idx] : i === idx ? arr[idx + 1] : x)))}>
                      <ArrowDown />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label="Remove question" onClick={() => set('questions', v.questions.filter((_, i) => i !== idx))}>
                      <Trash2 className="text-rose-500" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section title="Reminders" description="Emailed to the candidate before the interview.">
        <label className="flex items-center gap-3 text-sm text-zinc-700">
          <Switch checked={v.reminderOffsetsMinutes === null} onCheckedChange={(c) => set('reminderOffsetsMinutes', c ? null : [...orgReminderDefault])} />
          Use organization default ({orgReminderDefault.length ? orgReminderDefault.map(formatReminderOffset).join(', ') : 'none'} before)
        </label>
        {v.reminderOffsetsMinutes !== null && (
          <div className="flex flex-wrap gap-2">
            {REMINDER_CHOICES.map((m) => {
              const on = v.reminderOffsetsMinutes!.includes(m);
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => set('reminderOffsetsMinutes', on ? v.reminderOffsetsMinutes!.filter((x) => x !== m) : [...v.reminderOffsetsMinutes!, m].slice(0, 5))}
                  className={cn('rounded-full border px-3 py-1 text-sm font-medium transition', on ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-zinc-200 text-zinc-600 hover:border-zinc-300')}
                >
                  {formatReminderOffset(m)} before
                </button>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Visibility">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-zinc-800">Accepting bookings</p>
            <p className="text-xs text-zinc-500">When off, the booking page shows as unavailable. Existing interviews are unaffected.</p>
          </div>
          <Switch checked={v.isActive} onCheckedChange={(c) => set('isActive', c)} aria-label="Accepting bookings" />
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              ['public', 'Public', 'Listed on your booking page; anyone with the link can book.'],
              ['link_only', 'Private link only', 'Hidden from your booking page. Candidates need a personal scheduling link.'],
            ] as const
          ).map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              onClick={() => set('visibility', value)}
              className={cn('rounded-xl border p-3 text-left', v.visibility === value ? 'border-brand-600 bg-brand-50/60 ring-1 ring-brand-600' : 'border-zinc-200 hover:border-zinc-300')}
            >
              <span className="flex items-center gap-2 text-sm font-medium text-zinc-800">
                {value === 'link_only' && <Link2 className="size-4" />} {label}
              </span>
              <span className="mt-0.5 block text-xs text-zinc-500">{hint}</span>
            </button>
          ))}
        </div>
      </Section>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-zinc-200 bg-white/95 backdrop-blur lg:pl-64">
        <div className="mx-auto flex max-w-[1320px] items-center justify-end gap-2 px-4 py-3 sm:px-6 lg:px-8">
          <Button variant="secondary" onClick={() => router.push('/event-types')} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy}>
            {mode === 'create' ? 'Create event type' : 'Save changes'}
          </Button>
        </div>
      </div>
    </div>
  );
}
