'use client';

import { DateTime } from 'luxon';
import { CalendarCheck2, CalendarPlus, CalendarX2, Clock, Copy, Download, Globe2, User, Video } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { api } from '@/lib/api-client';
import { formatDuration } from '@/lib/format';
import { zoneLabel } from '@/lib/time';
import { LocationIcon } from './event-summary';
import { OrgBrand } from './public-frame';

export interface BookingView {
  status: 'scheduled' | 'rescheduled' | 'cancelled' | 'completed' | 'no_show';
  startAt: string;
  endAt: string;
  candidateTimezone: string;
  host: { name: string; title: string | null };
  organization: { name: string; logoUrl: string | null; brandColor: string };
  eventType: { name: string; durationMinutes: number; color: string; bookAgainUrl: string | null };
  location: { type: string; label: string; joinUrl: string | null; passcode: string | null; pending: boolean };
  candidate: { name: string; email: string };
  cancelReason: string | null;
  links: { view: string | null; reschedule: string | null; cancel: string | null };
  policy: { canReschedule: boolean; canCancel: boolean; reason: string | null };
}

function calendarLinks(v: BookingView) {
  const title = `${v.eventType.name} with ${v.host.name}`;
  const fmt = (iso: string) => DateTime.fromISO(iso).toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'");
  const details = [v.location.joinUrl ? `Join: ${v.location.joinUrl}` : '', v.links.view ? `Details: ${v.links.view}` : ''].filter(Boolean).join('\n');
  const location = v.location.joinUrl ?? (v.location.type === 'zoom' ? '' : v.location.label);
  const google = new URL('https://calendar.google.com/calendar/render');
  google.search = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${fmt(v.startAt)}/${fmt(v.endAt)}`, details, location }).toString();
  const outlook = new URL('https://outlook.live.com/calendar/0/deeplink/compose');
  outlook.search = new URLSearchParams({ subject: title, startdt: v.startAt, enddt: v.endAt, body: details, location, path: '/calendar/action/compose', rru: 'addevent' }).toString();
  return { google: google.toString(), outlook: outlook.toString() };
}

/** Candidate-facing interview details: confirmation page, and header of reschedule/cancel pages. */
export function BookingDetails({ view: initial, token, heading, justBooked }: { view: BookingView; token: string | null; heading?: 'booked' | 'rescheduled' | 'details'; justBooked?: boolean }) {
  const [view, setView] = useState(initial);
  const accent = view.organization.brandColor;
  const zone = view.candidateTimezone;
  const start = DateTime.fromISO(view.startAt, { zone });
  const end = DateTime.fromISO(view.endAt, { zone });
  const cancelled = view.status === 'cancelled';
  const past = view.status === 'completed' || view.status === 'no_show';

  // The Zoom meeting is created right after booking; poll briefly until the link is ready.
  useEffect(() => {
    if (!token || !view.location.pending) return;
    let tries = 0;
    const id = setInterval(async () => {
      tries++;
      try {
        const next = await api<BookingView>(`/api/public/bookings/${token}`);
        setView(next);
        if (!next.location.pending || tries > 15) clearInterval(id);
      } catch {
        if (tries > 15) clearInterval(id);
      }
    }, 4000);
    return () => clearInterval(id);
  }, [token, view.location.pending]);

  const cal = calendarLinks(view);
  const title = cancelled
    ? 'This interview was cancelled'
    : past
      ? 'This interview has taken place'
      : heading === 'rescheduled'
        ? 'Your interview has been rescheduled'
        : heading === 'booked' || justBooked
          ? 'Your interview is scheduled'
          : 'Your interview';

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-card">
      <div className="h-1" style={{ backgroundColor: cancelled ? '#e11d48' : accent }} />
      <div className="px-6 pb-8 pt-7 sm:px-10">
        <div className="mb-8 flex items-center justify-between">
          <OrgBrand name={view.organization.name} logoUrl={view.organization.logoUrl} />
        </div>
        <div className="text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full" style={{ backgroundColor: cancelled ? '#fff1f2' : `${accent}14`, color: cancelled ? '#e11d48' : accent }}>
            {cancelled ? <CalendarX2 className="size-6" /> : <CalendarCheck2 className="size-6" />}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{title}</h1>
          {!cancelled && !past && (
            <p className="mt-1.5 text-sm text-zinc-500">
              A calendar invitation and confirmation have been sent to <span className="font-medium text-zinc-700">{view.candidate.email}</span>.
            </p>
          )}
          {cancelled && view.cancelReason && <p className="mt-2 text-sm text-zinc-500">Reason: {view.cancelReason}</p>}
        </div>

        <div className="mx-auto mt-8 max-w-md space-y-4 rounded-xl border border-zinc-200 p-5">
          <p className="text-base font-semibold text-zinc-900">{view.eventType.name}</p>
          <ul className="space-y-3 text-sm text-zinc-700">
            <li className="flex gap-3">
              <User className="mt-0.5 size-4 shrink-0 text-zinc-400" />
              <span className="flex items-center gap-2">
                <Avatar name={view.host.name} size="xs" />
                {view.host.name}
                {view.host.title && <span className="text-zinc-400">· {view.host.title}</span>}
              </span>
            </li>
            <li className={`flex gap-3 ${cancelled ? 'line-through decoration-zinc-400' : ''}`}>
              <Clock className="mt-0.5 size-4 shrink-0 text-zinc-400" />
              <span>
                <span className="font-medium text-zinc-900">
                  {start.toFormat('h:mm a')} – {end.toFormat('h:mm a')}
                </span>
                , {start.toFormat('cccc, LLLL d, yyyy')}
                <span className="block text-xs text-zinc-500">{formatDuration(view.eventType.durationMinutes)}</span>
              </span>
            </li>
            <li className="flex gap-3">
              <Globe2 className="mt-0.5 size-4 shrink-0 text-zinc-400" />
              {zoneLabel(zone)} ({start.toFormat('ZZZZ')})
            </li>
            {!cancelled && (
              <li className="flex gap-3">
                <LocationIcon type={view.location.type} className="mt-0.5 size-4 shrink-0 text-zinc-400" />
                {view.location.joinUrl ? (
                  <span className="min-w-0">
                    <a href={view.location.joinUrl} target="_blank" rel="noreferrer" className="break-all font-medium hover:underline" style={{ color: accent }}>
                      {view.location.joinUrl}
                    </a>
                    {view.location.passcode && <span className="block text-xs text-zinc-500">Passcode: {view.location.passcode}</span>}
                  </span>
                ) : view.location.pending ? (
                  <span className="inline-flex items-center gap-2 text-zinc-500">
                    <Spinner className="size-3.5" /> Creating your Zoom meeting… the link will also be emailed to you.
                  </span>
                ) : (
                  <span>{view.location.label}</span>
                )}
              </li>
            )}
          </ul>
          {!cancelled && !past && view.location.joinUrl && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button asChild size="sm" style={{ backgroundColor: accent }}>
                <a href={view.location.joinUrl} target="_blank" rel="noreferrer">
                  <Video /> Join Zoom
                </a>
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => navigator.clipboard.writeText(view.location.joinUrl!).then(() => toast.success('Meeting link copied'))}
              >
                <Copy /> Copy link
              </Button>
            </div>
          )}
        </div>

        {!cancelled && !past && (
          <div className="mx-auto mt-5 max-w-md">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Add to calendar</p>
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm" variant="secondary">
                <a href={cal.google} target="_blank" rel="noreferrer">
                  <CalendarPlus /> Google
                </a>
              </Button>
              <Button asChild size="sm" variant="secondary">
                <a href={cal.outlook} target="_blank" rel="noreferrer">
                  <CalendarPlus /> Outlook
                </a>
              </Button>
              {token && (
                <Button asChild size="sm" variant="secondary">
                  <a href={`/api/public/bookings/${token}/ics`}>
                    <Download /> Apple / .ics
                  </a>
                </Button>
              )}
            </div>
          </div>
        )}

        <div className="mx-auto mt-8 max-w-md border-t border-zinc-100 pt-5 text-center text-sm">
          {cancelled ? (
            view.eventType.bookAgainUrl ? (
              <Link href={view.eventType.bookAgainUrl} className="font-medium hover:underline" style={{ color: accent }}>
                Book a new time
              </Link>
            ) : (
              <span className="text-zinc-500">Contact your recruiter to arrange a new time.</span>
            )
          ) : view.policy.canReschedule || view.policy.canCancel ? (
            <span className="text-zinc-500">
              Need to make a change?{' '}
              {view.policy.canReschedule && view.links.reschedule && (
                <a href={view.links.reschedule} className="font-medium hover:underline" style={{ color: accent }}>
                  Reschedule
                </a>
              )}
              {view.policy.canReschedule && view.policy.canCancel && ' or '}
              {view.policy.canCancel && view.links.cancel && (
                <a href={view.links.cancel} className="font-medium hover:underline" style={{ color: accent }}>
                  Cancel
                </a>
              )}
            </span>
          ) : (
            view.policy.reason && <span className="text-zinc-500">{view.policy.reason}</span>
          )}
        </div>
      </div>
    </div>
  );
}
