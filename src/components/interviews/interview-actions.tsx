'use client';

import { DateTime } from 'luxon';
import { CalendarClock, CalendarX2, CheckCircle2, ChevronDown, Copy, ExternalLink, RefreshCw, UserX, Video } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { SlotPicker, type FetchSlots, type Slot } from '@/components/scheduling/slot-picker';
import { TimezoneSelect } from '@/components/scheduling/timezone-select';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Dropdown, DropdownContent, DropdownItem, DropdownTrigger } from '@/components/ui/dropdown';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Segmented } from '@/components/ui/tabs';
import { api, ApiError, errorMessage } from '@/lib/api-client';

export interface ActionInterview {
  id: string;
  startAt: string;
  endAt: string;
  timezone: string;
  candidateName: string;
  joinUrl: string | null;
  calendarLink: string | null;
}

export function InterviewActions({
  interview,
  viewerTimezone,
  permissions,
}: {
  interview: ActionInterview;
  viewerTimezone: string;
  permissions: { canReschedule: boolean; canCancel: boolean; canMarkOutcome: boolean; canRetrySync: boolean; canStartMeeting: boolean };
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<'reschedule' | 'cancel' | null>(null);
  const [syncing, setSyncing] = useState(false);

  async function markOutcome(status: 'completed' | 'no_show') {
    try {
      await api(`/api/interviews/${interview.id}`, { method: 'PATCH', body: { status } });
      toast.success(status === 'no_show' ? 'Marked as no-show' : 'Marked as completed');
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function retrySync() {
    setSyncing(true);
    try {
      const res = await api<{ errors: string[]; retryable: boolean }>(`/api/interviews/${interview.id}/sync`, { body: {} });
      if (res.errors.length) toast.error(`Some integrations still failed: ${res.errors[0]}${res.retryable ? ' — will keep retrying automatically.' : ''}`);
      else toast.success('Integrations are in sync');
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {permissions.canStartMeeting && (
        <Button asChild>
          <a href={`/api/interviews/${interview.id}/zoom/start`} target="_blank" rel="noreferrer">
            <Video /> Start Zoom
          </a>
        </Button>
      )}
      {!permissions.canStartMeeting && interview.joinUrl && (
        <Button asChild>
          <a href={interview.joinUrl} target="_blank" rel="noreferrer">
            <Video /> Open Zoom
          </a>
        </Button>
      )}
      {interview.joinUrl && (
        <Button variant="secondary" onClick={() => navigator.clipboard.writeText(interview.joinUrl!).then(() => toast.success('Meeting link copied'))}>
          <Copy /> Copy meeting link
        </Button>
      )}
      {interview.calendarLink && (
        <Button asChild variant="secondary">
          <a href={interview.calendarLink} target="_blank" rel="noreferrer">
            <ExternalLink /> Open in Calendar
          </a>
        </Button>
      )}
      {permissions.canReschedule && (
        <Button variant="secondary" onClick={() => setDialog('reschedule')}>
          <CalendarClock /> Reschedule
        </Button>
      )}
      {permissions.canCancel && (
        <Button variant="danger-outline" onClick={() => setDialog('cancel')}>
          <CalendarX2 /> Cancel
        </Button>
      )}
      {(permissions.canMarkOutcome || permissions.canRetrySync) && (
        <Dropdown>
          <DropdownTrigger asChild>
            <Button variant="secondary" aria-label="More actions">
              More <ChevronDown />
            </Button>
          </DropdownTrigger>
          <DropdownContent>
            {permissions.canRetrySync && (
              <DropdownItem onSelect={retrySync} disabled={syncing}>
                <RefreshCw /> Retry integration sync
              </DropdownItem>
            )}
            {permissions.canMarkOutcome && (
              <>
                <DropdownItem onSelect={() => markOutcome('completed')}>
                  <CheckCircle2 /> Mark as completed
                </DropdownItem>
                <DropdownItem onSelect={() => markOutcome('no_show')}>
                  <UserX /> Mark as no-show
                </DropdownItem>
              </>
            )}
          </DropdownContent>
        </Dropdown>
      )}

      <RescheduleDialog open={dialog === 'reschedule'} onOpenChange={(o) => setDialog(o ? 'reschedule' : null)} interview={interview} viewerTimezone={viewerTimezone} />
      <CancelDialog open={dialog === 'cancel'} onOpenChange={(o) => setDialog(o ? 'cancel' : null)} interview={interview} />
    </div>
  );
}

function RescheduleDialog({ open, onOpenChange, interview, viewerTimezone }: { open: boolean; onOpenChange: (o: boolean) => void; interview: ActionInterview; viewerTimezone: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<'available' | 'custom'>('available');
  const [timezone, setTimezone] = useState(viewerTimezone);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [customDate, setCustomDate] = useState('');
  const [customTime, setCustomTime] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [pickerKey, setPickerKey] = useState(0);
  const duration = DateTime.fromISO(interview.endAt).diff(DateTime.fromISO(interview.startAt), 'minutes').minutes;

  const fetchSlots: FetchSlots = useCallback(
    (range, signal) => api(`/api/interviews/${interview.id}/availability?start=${encodeURIComponent(range.start.toISOString())}&end=${encodeURIComponent(range.end.toISOString())}`, { signal }),
    [interview.id],
  );

  const customStart = customDate && customTime ? DateTime.fromISO(`${customDate}T${customTime}`, { zone: timezone }) : null;
  const target = mode === 'available' ? (slot ? DateTime.fromISO(slot.start, { zone: timezone }) : null) : customStart?.isValid ? customStart : null;

  async function submit() {
    if (!target) return;
    setBusy(true);
    try {
      await api(`/api/interviews/${interview.id}/reschedule`, {
        body: { start: target.toUTC().toISO(), reason: reason || null, ignoreWorkingHours: mode === 'custom' },
      });
      toast.success(`Rescheduled — ${interview.candidateName} has been notified`);
      onOpenChange(false);
      setSlot(null);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SLOT_UNAVAILABLE') {
        toast.error(err.message);
        setSlot(null);
        setPickerKey((k) => k + 1);
      } else toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent title={`Reschedule interview with ${interview.candidateName}`} description="Zoom, the calendar event and the candidate are updated automatically. The original time is kept in the history." size="xl">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <Segmented
            value={mode}
            onChange={(m) => {
              setMode(m);
              setSlot(null);
            }}
            options={[
              { value: 'available', label: 'Available times' },
              { value: 'custom', label: 'Custom time' },
            ]}
          />
          <p className="text-sm text-zinc-500">
            Currently <span className="font-medium text-zinc-800">{DateTime.fromISO(interview.startAt, { zone: timezone }).toFormat('ccc, LLL d · h:mm a')}</span>
          </p>
        </div>
        {mode === 'available' ? (
          slot ? (
            <div className="rounded-xl border border-brand-200 bg-brand-50/50 p-4 text-sm">
              <p className="font-semibold text-zinc-900">
                New time: {DateTime.fromISO(slot.start, { zone: timezone }).toFormat('cccc, LLLL d · h:mm a')} – {DateTime.fromISO(slot.end, { zone: timezone }).toFormat('h:mm a ZZZZ')}
              </p>
              <Button variant="link" size="sm" onClick={() => setSlot(null)}>
                Choose a different time
              </Button>
            </div>
          ) : (
            <SlotPicker key={pickerKey} fetchSlots={fetchSlots} timezone={timezone} onTimezoneChange={setTimezone} onConfirm={setSlot} confirmLabel="Select" disabledSlot={interview.startAt} compact />
          )
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Date" htmlFor="rs-date">
              <Input id="rs-date" type="date" value={customDate} onChange={(e) => setCustomDate(e.target.value)} />
            </Field>
            <Field label="Start time" htmlFor="rs-time" hint={`${duration} minutes`}>
              <Input id="rs-time" type="time" step={300} value={customTime} onChange={(e) => setCustomTime(e.target.value)} />
            </Field>
            <Field label="Time zone">
              <TimezoneSelect value={timezone} onChange={setTimezone} />
            </Field>
            <p className="text-xs text-zinc-500 sm:col-span-3">
              Custom times may fall outside working hours, but never overlap another interview or a busy time on the interviewer’s calendar.
            </p>
          </div>
        )}
        <Field label="Reason" htmlFor="rs-reason" optionalTag className="mt-5" hint="Included in the notification to the candidate.">
          <Textarea id="rs-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={1000} />
        </Field>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Close
          </Button>
          <Button onClick={submit} loading={busy} disabled={!target}>
            Reschedule & notify
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CancelDialog({ open, onOpenChange, interview }: { open: boolean; onOpenChange: (o: boolean) => void; interview: ActionInterview }) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent title="Cancel this interview?" description={`${interview.candidateName} will be notified by email. The Zoom meeting and calendar event will be removed.`} size="sm">
        <Field label="Reason" htmlFor="cancel-reason" optionalTag hint="Shared with the candidate.">
          <Textarea id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} placeholder="e.g. The position has been filled." />
        </Field>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Keep interview
          </Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/api/interviews/${interview.id}/cancel`, { body: { reason: reason || null } });
                toast.success('Interview cancelled — candidate notified');
                onOpenChange(false);
                router.refresh();
              } catch (err) {
                toast.error(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            Cancel interview
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RetrySyncButton({ interviewId, label = 'Retry' }: { interviewId: string; label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      size="xs"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await api<{ errors: string[] }>(`/api/interviews/${interviewId}/sync`, { body: {} });
          if (res.errors.length) toast.error(res.errors[0]);
          else toast.success('Synced');
          router.refresh();
        } catch (err) {
          toast.error(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {!busy && <RefreshCw />} {label}
    </Button>
  );
}
