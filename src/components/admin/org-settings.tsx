'use client';

import { DateTime } from 'luxon';
import { Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { TimezoneSelect } from '@/components/scheduling/timezone-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api, ApiError, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { formatReminderOffset } from '@/lib/format';

export interface OrgSettingsValue {
  name: string;
  brandColor: string;
  logoUrl: string | null;
  defaultTimezone: string;
  settings: {
    reminderOffsetsMinutes: number[];
    candidateCanReschedule: boolean;
    candidateCanCancel: boolean;
    candidateManageCutoffMinutes: number;
    addCandidateAsCalendarAttendee: boolean;
    bookingPageNotice: string;
  };
}

const REMINDER_CHOICES = [10080, 2880, 1440, 240, 120, 60, 30, 15];

export function OrgSettingsForm({ initial }: { initial: OrgSettingsValue }) {
  const router = useRouter();
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const s = v.settings;
  const setS = (patch: Partial<OrgSettingsValue['settings']>) => setV({ ...v, settings: { ...s, ...patch } });

  return (
    <form
      className="space-y-6"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErrors({});
        try {
          await api('/api/admin/organization', { method: 'PATCH', body: { ...v, logoUrl: v.logoUrl || null } });
          toast.success('Organization settings saved');
          router.refresh();
        } catch (err) {
          if (err instanceof ApiError) setErrors(err.fieldErrors);
          toast.error(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Card>
        <CardHeader title="Organization & branding" description="Shown on booking pages and in every email to candidates." />
        <CardBody className="grid gap-5 md:grid-cols-2">
          <Field label="Organization name" htmlFor="org-name" error={errors.name}>
            <Input id="org-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required />
          </Field>
          <Field label="Default time zone" hint="Used for new members and org-wide reports.">
            <TimezoneSelect value={v.defaultTimezone} onChange={(tz) => setV({ ...v, defaultTimezone: tz })} />
          </Field>
          <Field label="Logo URL" htmlFor="org-logo" optionalTag error={errors.logoUrl} hint="An https image URL. Shown instead of the organization name.">
            <Input id="org-logo" value={v.logoUrl ?? ''} onChange={(e) => setV({ ...v, logoUrl: e.target.value })} placeholder="https://…/logo.png" />
          </Field>
          <Field label="Brand colour" htmlFor="org-color" error={errors.brandColor}>
            <div className="flex items-center gap-2">
              <input type="color" aria-label="Pick brand colour" value={v.brandColor} onChange={(e) => setV({ ...v, brandColor: e.target.value })} className="h-9 w-12 cursor-pointer rounded-lg border border-zinc-300 bg-white p-1" />
              <Input id="org-color" value={v.brandColor} onChange={(e) => setV({ ...v, brandColor: e.target.value })} className="w-32 font-mono" />
            </div>
          </Field>
          <Field label="Booking page notice" htmlFor="org-notice" optionalTag className="md:col-span-2" hint="e.g. a privacy notice or what candidates should prepare.">
            <Textarea id="org-notice" rows={2} value={s.bookingPageNotice} onChange={(e) => setS({ bookingPageNotice: e.target.value })} maxLength={1000} />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Candidate self-service" description="What candidates can do from the links in their emails." />
        <CardBody className="space-y-4">
          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm font-medium text-zinc-800">Allow candidates to reschedule</span>
              <span className="block text-xs text-zinc-500">Using the secure reschedule link in their confirmation.</span>
            </span>
            <Switch checked={s.candidateCanReschedule} onCheckedChange={(c) => setS({ candidateCanReschedule: c })} />
          </label>
          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm font-medium text-zinc-800">Allow candidates to cancel</span>
              <span className="block text-xs text-zinc-500">Cancellations notify the interviewer immediately.</span>
            </span>
            <Switch checked={s.candidateCanCancel} onCheckedChange={(c) => setS({ candidateCanCancel: c })} />
          </label>
          <Field label="Changes allowed until" htmlFor="cutoff" className="max-w-xs">
            <Select id="cutoff" value={s.candidateManageCutoffMinutes} onChange={(e) => setS({ candidateManageCutoffMinutes: Number(e.target.value) })}>
              <option value={0}>The interview starts</option>
              <option value={60}>1 hour before</option>
              <option value={240}>4 hours before</option>
              <option value={1440}>24 hours before</option>
              <option value={2880}>48 hours before</option>
            </Select>
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Reminders & calendar" />
        <CardBody className="space-y-5">
          <div>
            <p className="text-sm font-medium text-zinc-800">Default candidate reminders</p>
            <p className="mb-3 text-xs text-zinc-500">Event types can override this. Reminders are sent by the background worker at the scheduled time.</p>
            <div className="flex flex-wrap gap-2">
              {REMINDER_CHOICES.map((m) => {
                const on = s.reminderOffsetsMinutes.includes(m);
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setS({ reminderOffsetsMinutes: on ? s.reminderOffsetsMinutes.filter((x) => x !== m) : [...s.reminderOffsetsMinutes, m].slice(0, 5) })}
                    className={cn('rounded-full border px-3 py-1 text-sm font-medium', on ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-zinc-200 text-zinc-600 hover:border-zinc-300')}
                  >
                    {formatReminderOffset(m)} before
                  </button>
                );
              })}
            </div>
          </div>
          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm font-medium text-zinc-800">Add candidates as guests on Google Calendar events</span>
              <span className="block text-xs text-zinc-500">When on, Google also emails the candidate its own invitation. When off, candidates get Slate’s calendar invite only.</span>
            </span>
            <Switch checked={s.addCandidateAsCalendarAttendee} onCheckedChange={(c) => setS({ addCandidateAsCalendarAttendee: c })} />
          </label>
        </CardBody>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" loading={busy}>
          Save organization settings
        </Button>
      </div>
    </form>
  );
}

export function HolidaysManager({ holidays }: { holidays: { id: string; date: string; name: string }[] }) {
  const router = useRouter();
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const upcoming = holidays.filter((h) => h.date >= DateTime.now().toISODate()!);
  return (
    <Card>
      <CardHeader title="Company holidays" description="No one in the organization can be booked on these dates." />
      <CardBody>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api('/api/admin/holidays', { body: { date, name } });
              setDate('');
              setName('');
              toast.success('Holiday added');
              router.refresh();
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Date" htmlFor="hol-date">
            <Input id="hol-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label="Name" htmlFor="hol-name" className="min-w-[200px] flex-1">
            <Input id="hol-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Company offsite" required />
          </Field>
          <Button type="submit" variant="secondary" loading={busy}>
            <Plus /> Add
          </Button>
        </form>
        <ul className="mt-4 divide-y divide-zinc-100">
          {upcoming.length === 0 && <li className="py-3 text-sm text-zinc-500">No upcoming holidays.</li>}
          {upcoming.map((h) => (
            <li key={h.id} className="flex items-center justify-between py-2.5">
              <span className="text-sm">
                <span className="font-medium text-zinc-900">{DateTime.fromISO(h.date).toFormat('ccc, LLL d, yyyy')}</span> <span className="text-zinc-500">· {h.name}</span>
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${h.name}`}
                onClick={async () => {
                  try {
                    await api(`/api/admin/holidays/${h.id}`, { method: 'DELETE' });
                    router.refresh();
                  } catch (err) {
                    toast.error(errorMessage(err));
                  }
                }}
              >
                <Trash2 className="text-zinc-400" />
              </Button>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

const TEMPLATE_LABELS: Record<string, { label: string; audience: string }> = {
  booking_confirmation: { label: 'Booking confirmation', audience: 'Candidate' },
  reschedule_confirmation: { label: 'Reschedule confirmation', audience: 'Candidate' },
  cancellation: { label: 'Cancellation', audience: 'Candidate' },
  reminder: { label: 'Reminder', audience: 'Candidate' },
  meeting_details_update: { label: 'Meeting link update', audience: 'Candidate' },
  host_booking_notification: { label: 'New booking', audience: 'Interviewer' },
  host_reschedule_notification: { label: 'Rescheduled', audience: 'Interviewer' },
  host_cancellation_notification: { label: 'Cancelled', audience: 'Interviewer' },
};

export function TemplatesEditor({ templates }: { templates: { type: string; subject: string | null; intro: string | null; enabled: boolean; updatedAt: string | null; updatedBy: string | null }[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<(typeof templates)[number] | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card>
      <CardHeader title="Email templates" description="Customize subject lines and intro text. Placeholders: {{candidate_name}}, {{candidate_first_name}}, {{interviewer_name}}, {{event_name}}, {{organization_name}}, {{date}}, {{time}}, {{timezone}}." />
      <ul className="divide-y divide-zinc-100">
        {templates.map((t) => (
          <li key={t.type} className="flex items-center justify-between gap-3 px-5 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-zinc-900">
                {TEMPLATE_LABELS[t.type]?.label ?? t.type} <span className="font-normal text-zinc-400">· {TEMPLATE_LABELS[t.type]?.audience}</span>
              </p>
              <p className="truncate text-xs text-zinc-500">{t.subject ? `Subject: ${t.subject}` : 'Default copy'}</p>
            </div>
            <div className="flex items-center gap-2">
              {!t.enabled && <Badge tone="amber">Off</Badge>}
              {(t.subject || t.intro) && <Badge tone="brand">Customized</Badge>}
              <Button variant="secondary" size="sm" onClick={() => setEditing(t)}>
                Edit
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <Dialog open={Boolean(editing)} onOpenChange={(o) => !o && setEditing(null)}>
        {editing && (
          <DialogContent title={`Edit “${TEMPLATE_LABELS[editing.type]?.label ?? editing.type}” email`} description="Leave blank to use Slate’s default copy. Interview details, links and the calendar invite are always included.">
            <form
              className="space-y-4"
              onSubmit={async (e) => {
                e.preventDefault();
                const d = new FormData(e.currentTarget);
                setBusy(true);
                try {
                  await api(`/api/admin/templates/${editing.type}`, { method: 'PUT', body: { subject: d.get('subject') || null, intro: d.get('intro') || null, enabled: d.get('enabled') === 'on' || editing.type === 'cancellation' } });
                  toast.success('Template saved');
                  setEditing(null);
                  router.refresh();
                } catch (err) {
                  toast.error(errorMessage(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Field label="Subject" htmlFor="tpl-subject" optionalTag>
                <Input id="tpl-subject" name="subject" defaultValue={editing.subject ?? ''} maxLength={200} placeholder="e.g. You’re confirmed: {{event_name}} on {{date}}" />
              </Field>
              <Field label="Intro paragraph" htmlFor="tpl-intro" optionalTag>
                <Textarea id="tpl-intro" name="intro" rows={4} defaultValue={editing.intro ?? ''} maxLength={2000} placeholder="Hi {{candidate_first_name}}, thanks for your interest in {{organization_name}}…" />
              </Field>
              <label className="flex items-center gap-2 text-sm text-zinc-700">
                <input type="checkbox" name="enabled" defaultChecked={editing.enabled} disabled={editing.type === 'cancellation'} className="size-4 accent-brand-600" />
                Send this email{editing.type === 'cancellation' && ' (always sent)'}
              </label>
              <DialogFooter>
                <Button variant="secondary" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
                <Button type="submit" loading={busy}>
                  Save template
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </Card>
  );
}
