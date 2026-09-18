'use client';

import { DateTime } from 'luxon';
import { ArrowLeft, CalendarClock } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, Select, Textarea } from '@/components/ui/input';
import { api, ApiError, errorMessage } from '@/lib/api-client';
import { browserTimeZone, zoneLabel } from '@/lib/time';
import { EventSummary } from './event-summary';
import { SlotPicker, type FetchSlots, type Slot } from './slot-picker';

type FieldMode = 'hidden' | 'optional' | 'required';

export interface BookingFlowProps {
  username: string;
  eventSlug: string;
  linkToken: string | null;
  organization: { name: string; logoUrl: string | null; brandColor: string; bookingPageNotice: string | null };
  host: { name: string; title: string | null };
  eventType: {
    name: string;
    description: string | null;
    durationMinutes: number;
    locationType: string;
    locationLabel: string;
    timezone: string;
    maxDaysInFuture: number | null;
    fieldConfig: { phone: FieldMode; company: FieldMode; linkedinUrl: FieldMode; resumeUrl: FieldMode };
    questions: { id: string; label: string; type: 'short_text' | 'long_text' | 'single_select' | 'url'; required: boolean; options?: string[]; helpText?: string }[];
  };
  prefill: { name: string | null; email: string | null } | null;
}

function newKey() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '') : `${Date.now()}${Math.random().toString(36).slice(2)}`;
}

export function BookingFlow(props: BookingFlowProps) {
  const router = useRouter();
  const accent = props.organization.brandColor;
  const [timezone, setTimezone] = useState(props.eventType.timezone);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const [pickerKey, setPickerKey] = useState(0);

  useEffect(() => setTimezone(browserTimeZone()), []);

  const fetchSlots: FetchSlots = useCallback(
    async (range, signal) => {
      const params = new URLSearchParams({ start: range.start.toISOString(), end: range.end.toISOString() });
      if (props.linkToken) params.set('link', props.linkToken);
      return api(`/api/public/availability/${props.username}/${props.eventSlug}?${params}`, { signal });
    },
    [props.username, props.eventSlug, props.linkToken],
  );

  const fc = props.eventType.fieldConfig;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!slot) return;
    const data = new FormData(e.currentTarget);
    const answers: Record<string, string> = {};
    for (const q of props.eventType.questions) answers[q.id] = String(data.get(`q_${q.id}`) ?? '');
    setBusy(true);
    setErrors({});
    setFormError(null);
    try {
      const res = await api<{ confirmationUrl: string | null }>(`/api/public/book/${props.username}/${props.eventSlug}`, {
        body: {
          start: slot.start,
          name: data.get('name'),
          email: data.get('email'),
          phone: data.get('phone') || null,
          company: data.get('company') || null,
          linkedinUrl: data.get('linkedinUrl') || null,
          resumeUrl: data.get('resumeUrl') || null,
          timezone,
          answers,
          link: props.linkToken,
          idempotencyKey,
        },
      });
      if (res.confirmationUrl) router.push(res.confirmationUrl);
      else toast.success('Your interview is scheduled.');
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError) {
        if (err.code === 'SLOT_UNAVAILABLE') {
          toast.error('That time was just taken. Please choose another time.');
          setSlot(null);
          setIdempotencyKey(newKey());
          setPickerKey((k) => k + 1);
          return;
        }
        if (err.code === 'VALIDATION_ERROR') {
          const fe = err.fieldErrors;
          const mapped: Record<string, string> = {};
          for (const [k, v] of Object.entries(fe)) mapped[k.startsWith('answers.') ? `q_${k.slice(8)}` : k] = v;
          setErrors(mapped);
        }
        setFormError(err.message);
        if (err.code !== 'VALIDATION_ERROR') setIdempotencyKey(newKey());
        return;
      }
      setFormError(errorMessage(err));
    }
  }

  const when = slot
    ? {
        date: DateTime.fromISO(slot.start, { zone: timezone }).toFormat('cccc, LLLL d, yyyy'),
        time: `${DateTime.fromISO(slot.start, { zone: timezone }).toFormat('h:mm a')} – ${DateTime.fromISO(slot.end, { zone: timezone }).toFormat('h:mm a')}`,
      }
    : null;

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-card">
      <div className="h-1" style={{ backgroundColor: accent }} />
      <div className="grid md:grid-cols-[320px_1fr]">
        <aside className="border-b border-zinc-100 p-6 sm:p-8 md:border-b-0 md:border-r">
          <EventSummary
            organization={props.organization}
            host={props.host}
            eventType={props.eventType}
            timezoneLabel={slot ? undefined : zoneLabel(timezone)}
          >
            {when && (
              <div className="rounded-xl border p-3.5 text-sm" style={{ borderColor: `${accent}40`, backgroundColor: `${accent}0d` }}>
                <p className="flex items-center gap-2 font-semibold" style={{ color: accent }}>
                  <CalendarClock className="size-4" /> {when.time}
                </p>
                <p className="mt-1 text-zinc-700">{when.date}</p>
                <p className="mt-0.5 text-xs text-zinc-500">{zoneLabel(timezone)}</p>
              </div>
            )}
          </EventSummary>
          {props.organization.bookingPageNotice && <p className="mt-6 border-t border-zinc-100 pt-5 text-xs leading-relaxed text-zinc-500">{props.organization.bookingPageNotice}</p>}
        </aside>

        <section className="p-6 sm:p-8">
          {!slot ? (
            <>
              <h2 className="mb-6 text-lg font-semibold text-zinc-900">Select a date & time</h2>
              <SlotPicker
                key={pickerKey}
                fetchSlots={fetchSlots}
                timezone={timezone}
                onTimezoneChange={setTimezone}
                onConfirm={setSlot}
                accent={accent}
                maxDaysAhead={props.eventType.maxDaysInFuture}
              />
            </>
          ) : (
            <form onSubmit={submit} className="max-w-lg space-y-5" noValidate>
              <button
                type="button"
                onClick={() => {
                  setSlot(null);
                  setFormError(null);
                }}
                className="-ml-1 inline-flex items-center gap-1.5 rounded-lg px-1 py-1 text-sm font-medium text-zinc-500 hover:text-zinc-800"
              >
                <ArrowLeft className="size-4" /> Change time
              </button>
              <h2 className="text-lg font-semibold text-zinc-900">Enter your details</h2>
              {formError && <Alert tone="error">{formError}</Alert>}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Full name" htmlFor="name" required error={errors.name}>
                  <Input id="name" name="name" autoComplete="name" required defaultValue={props.prefill?.name ?? ''} aria-invalid={Boolean(errors.name)} />
                </Field>
                <Field label="Email" htmlFor="email" required error={errors.email}>
                  <Input id="email" name="email" type="email" autoComplete="email" required defaultValue={props.prefill?.email ?? ''} aria-invalid={Boolean(errors.email)} />
                </Field>
              </div>
              {fc.phone !== 'hidden' && (
                <Field label="Phone" htmlFor="phone" required={fc.phone === 'required'} optionalTag={fc.phone === 'optional'} error={errors.phone}>
                  <Input id="phone" name="phone" type="tel" autoComplete="tel" aria-invalid={Boolean(errors.phone)} />
                </Field>
              )}
              {fc.company !== 'hidden' && (
                <Field label="Current company" htmlFor="company" required={fc.company === 'required'} optionalTag={fc.company === 'optional'} error={errors.company}>
                  <Input id="company" name="company" autoComplete="organization" aria-invalid={Boolean(errors.company)} />
                </Field>
              )}
              {fc.linkedinUrl !== 'hidden' && (
                <Field label="LinkedIn profile" htmlFor="linkedinUrl" required={fc.linkedinUrl === 'required'} optionalTag={fc.linkedinUrl === 'optional'} error={errors.linkedinUrl}>
                  <Input id="linkedinUrl" name="linkedinUrl" type="url" placeholder="https://www.linkedin.com/in/…" aria-invalid={Boolean(errors.linkedinUrl)} />
                </Field>
              )}
              {fc.resumeUrl !== 'hidden' && (
                <Field label="Résumé link" htmlFor="resumeUrl" required={fc.resumeUrl === 'required'} optionalTag={fc.resumeUrl === 'optional'} error={errors.resumeUrl} hint="A shareable link (Google Drive, Dropbox, personal site…).">
                  <Input id="resumeUrl" name="resumeUrl" type="url" placeholder="https://" aria-invalid={Boolean(errors.resumeUrl)} />
                </Field>
              )}
              {props.eventType.questions.map((q) => (
                <Field key={q.id} label={q.label} htmlFor={`q_${q.id}`} required={q.required} error={errors[`q_${q.id}`]} hint={q.helpText}>
                  {q.type === 'long_text' ? (
                    <Textarea id={`q_${q.id}`} name={`q_${q.id}`} rows={4} aria-invalid={Boolean(errors[`q_${q.id}`])} />
                  ) : q.type === 'single_select' ? (
                    <Select id={`q_${q.id}`} name={`q_${q.id}`} defaultValue="" aria-invalid={Boolean(errors[`q_${q.id}`])}>
                      <option value="" disabled>
                        Choose…
                      </option>
                      {q.options?.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input id={`q_${q.id}`} name={`q_${q.id}`} type={q.type === 'url' ? 'url' : 'text'} aria-invalid={Boolean(errors[`q_${q.id}`])} />
                  )}
                </Field>
              ))}
              <p className="text-xs leading-relaxed text-zinc-500">
                By confirming, you agree to share these details with {props.organization.name} for the purpose of this interview.
              </p>
              <Button type="submit" size="lg" loading={busy} className="w-full sm:w-auto" style={{ backgroundColor: accent }}>
                Schedule interview
              </Button>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
