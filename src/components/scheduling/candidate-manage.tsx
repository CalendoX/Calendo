'use client';

import { DateTime } from 'luxon';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/input';
import { api, ApiError, errorMessage } from '@/lib/api-client';
import { browserTimeZone, zoneLabel } from '@/lib/time';
import { SlotPicker, type FetchSlots, type Slot } from './slot-picker';

export function CandidateReschedule({ token, currentStart, accent, maxDaysAhead }: { token: string; currentStart: string; accent: string; maxDaysAhead?: number | null }) {
  const router = useRouter();
  const [timezone, setTimezone] = useState('UTC');
  const [slot, setSlot] = useState<Slot | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [pickerKey, setPickerKey] = useState(0);
  useEffect(() => setTimezone(browserTimeZone()), []);

  const fetchSlots: FetchSlots = useCallback(
    (range, signal) => api(`/api/public/bookings/reschedule/${token}/availability?start=${encodeURIComponent(range.start.toISOString())}&end=${encodeURIComponent(range.end.toISOString())}`, { signal }),
    [token],
  );

  async function confirm() {
    if (!slot) return;
    setBusy(true);
    try {
      const res = await api<{ confirmationUrl: string | null }>(`/api/public/bookings/reschedule/${token}`, { body: { start: slot.start, timezone, reason: reason || null } });
      toast.success('Your interview has been rescheduled');
      router.push(res.confirmationUrl ? `${res.confirmationUrl}?rescheduled=1` : '/');
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.code === 'SLOT_UNAVAILABLE') {
        toast.error('That time was just taken. Please pick another.');
        setSlot(null);
        setPickerKey((k) => k + 1);
        return;
      }
      toast.error(errorMessage(err));
    }
  }

  return (
    <>
      <SlotPicker key={pickerKey} fetchSlots={fetchSlots} timezone={timezone} onTimezoneChange={setTimezone} onConfirm={setSlot} confirmLabel="Choose" accent={accent} maxDaysAhead={maxDaysAhead} disabledSlot={currentStart} />
      <Dialog open={Boolean(slot)} onOpenChange={(o) => !o && !busy && setSlot(null)}>
        <DialogContent title="Confirm new time" description="Your interviewer and calendar invitation will be updated automatically.">
          {slot && (
            <div className="space-y-4">
              <div className="rounded-xl border border-zinc-200 p-4 text-sm">
                <p className="text-zinc-500 line-through">
                  {DateTime.fromISO(currentStart, { zone: timezone }).toFormat('ccc, LLL d · h:mm a')}
                </p>
                <p className="mt-1 font-semibold text-zinc-900">
                  {DateTime.fromISO(slot.start, { zone: timezone }).toFormat('cccc, LLLL d · h:mm a')} – {DateTime.fromISO(slot.end, { zone: timezone }).toFormat('h:mm a')}
                </p>
                <p className="mt-0.5 text-xs text-zinc-500">{zoneLabel(timezone)}</p>
              </div>
              <Field label="Reason for rescheduling" htmlFor="reason" optionalTag>
                <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} />
              </Field>
            </div>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setSlot(null)} disabled={busy}>
              Back
            </Button>
            <Button onClick={confirm} loading={busy} style={{ backgroundColor: accent }}>
              Reschedule interview
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function CandidateCancel({ token }: { token: string }) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api(`/api/public/bookings/cancel/${token}`, { body: { reason: reason || null } });
          toast.success('Your interview has been cancelled');
          router.refresh();
        } catch (err) {
          setError(errorMessage(err));
          setBusy(false);
        }
      }}
    >
      {error && <Alert tone="error">{error}</Alert>}
      <Field label="Reason for cancelling" htmlFor="reason" optionalTag hint="Shared with your interviewer.">
        <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} />
      </Field>
      <Button type="submit" variant="danger" loading={busy} className="w-full">
        Cancel interview
      </Button>
      <p className="text-center text-xs text-zinc-500">
        Prefer a different time instead? Use the reschedule link in your confirmation email.
      </p>
    </form>
  );
}
