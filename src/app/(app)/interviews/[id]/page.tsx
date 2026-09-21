import { DateTime } from 'luxon';
import {
  ArrowLeft,
  CalendarDays,
  Clock,
  ExternalLink,
  FileText,
  Globe2,
  Briefcase,
  Mail,
  MapPin,
  Phone,
  Building2,
  History,
  Video,
} from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { InterviewActions, RetrySyncButton } from '@/components/interviews/interview-actions';
import { InterviewStatusBadge, SyncBadge } from '@/components/interviews/status-badge';
import { Alert } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { formatDuration, locationLabel } from '@/lib/format';
import { requirePageAuth } from '@/server/auth/page-guards';
import { isAppError } from '@/server/http/errors';
import { getInterviewDetails, type InterviewDetails } from '@/server/services/interviews-service';

export const metadata: Metadata = { title: 'Interview' };

const ACTION_LABELS: Record<string, string> = {
  'interview.created': 'Interview booked',
  'interview.rescheduled': 'Rescheduled',
  'interview.cancelled': 'Cancelled',
  'interview.status_changed': 'Status changed',
  'interview.sync_retried': 'Integration sync retried',
  'integration.failure': 'Integration error',
  'integration.recovered': 'Integration recovered',
  'integration.external_change': 'Changed outside Calendo',
};

const NOTIFICATION_LABELS: Record<string, string> = {
  booking_confirmation: 'Booking confirmation',
  host_booking_notification: 'New booking (interviewer)',
  reschedule_confirmation: 'Reschedule confirmation',
  host_reschedule_notification: 'Reschedule (interviewer)',
  cancellation: 'Cancellation',
  host_cancellation_notification: 'Cancellation (interviewer)',
  reminder: 'Reminder',
  meeting_details_update: 'Meeting link update',
};

function describe(entry: InterviewDetails['timeline'][number], zone: string) {
  const m = entry.metadata as Record<string, unknown>;
  if (entry.action === 'interview.rescheduled' && typeof m.previousStart === 'string' && typeof m.newStart === 'string') {
    return `${DateTime.fromISO(m.previousStart, { zone }).toFormat('LLL d, h:mm a')} → ${DateTime.fromISO(m.newStart, { zone }).toFormat('LLL d, h:mm a')}${m.reason ? ` · “${m.reason}”` : ''}`;
  }
  if (entry.action === 'interview.cancelled') return m.reason ? `“${m.reason}”` : null;
  if (entry.action === 'interview.status_changed') return `${m.from} → ${m.to}`;
  if (entry.action === 'integration.failure') return `${m.provider}: ${m.error}`;
  if (entry.action === 'integration.external_change') return String(m.note ?? m.change ?? '');
  if (entry.action === 'interview.created') return `via ${String(m.source ?? 'booking page').replace('_', ' ')}`;
  return null;
}

export default async function InterviewDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requirePageAuth(`/interviews/${id}`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let d: InterviewDetails;
  try {
    d = await getInterviewDetails(auth, id);
  } catch (err) {
    if (isAppError(err) && err.status === 404) notFound();
    throw err;
  }
  const zone = auth.user.timezone;
  const i = d.interview;
  const start = DateTime.fromISO(i.startAt, { zone });
  const end = DateTime.fromISO(i.endAt, { zone });
  const hostStart = DateTime.fromISO(i.startAt, { zone: i.timezone });
  const candStart = DateTime.fromISO(i.startAt, { zone: i.candidateTimezone });
  const cancelled = i.status === 'cancelled';
  const meetingProblem = d.meeting && (d.meeting.status === 'failed' || d.meeting.status === 'deleted_externally');
  const calendarProblem = d.calendarEvent && (d.calendarEvent.status === 'failed' || d.calendarEvent.status === 'deleted_externally');

  return (
    <>
      <Link href="/interviews" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-zinc-500 hover:text-zinc-800">
        <ArrowLeft className="size-4" /> Scheduled interviews
      </Link>

      <div className="mb-6 flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-4">
          <Avatar name={d.candidate.name} size="lg" />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{d.candidate.name}</h1>
              <InterviewStatusBadge status={i.status} />
              {i.rescheduleCount > 0 && <Badge tone="violet">Rescheduled {i.rescheduleCount}×</Badge>}
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-zinc-500">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ backgroundColor: d.eventType.color }} />
                {d.eventType.name}
              </span>
              <span>·</span>
              <span className={cancelled ? 'line-through' : ''}>
                {start.toFormat('cccc, LLLL d')} · {start.toFormat('h:mm a')} – {end.toFormat('h:mm a ZZZZ')}
              </span>
            </p>
          </div>
        </div>
        <InterviewActions
          interview={{ id: i.id, startAt: i.startAt, endAt: i.endAt, timezone: i.timezone, candidateName: d.candidate.name, joinUrl: !cancelled && d.meeting?.status === 'synced' ? d.meeting.joinUrl : null, calendarLink: !cancelled && d.calendarEvent?.status === 'synced' ? d.calendarEvent.htmlLink : null }}
          viewerTimezone={zone}
          permissions={d.permissions}
        />
      </div>

      {cancelled && (
        <Alert tone="error" title={`Cancelled ${i.cancelledAt ? DateTime.fromISO(i.cancelledAt, { zone }).toFormat('LLL d, h:mm a') : ''} by ${i.cancelledByType === 'candidate' ? 'the candidate' : 'the team'}`} className="mb-6">
          {i.cancelReason ? `Reason: ${i.cancelReason}` : 'No reason provided.'}
        </Alert>
      )}
      {!cancelled && (meetingProblem || calendarProblem) && (
        <Alert tone="warning" title="Some integrations need attention" className="mb-6">
          {[d.meeting?.status === 'failed' && `Zoom: ${d.meeting.lastError}`, d.meeting?.status === 'deleted_externally' && 'The Zoom meeting was deleted in Zoom.', d.calendarEvent?.status === 'failed' && `Google Calendar: ${d.calendarEvent.lastError}`, d.calendarEvent?.status === 'deleted_externally' && 'The event was deleted from Google Calendar.']
            .filter(Boolean)
            .join(' ')}{' '}
          Use “Retry integration sync” to recreate them.
        </Alert>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader title="Interview" />
            <CardBody>
              <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-zinc-500">Interview type</dt>
                  <dd className="mt-0.5 font-medium text-zinc-900">{d.eventType.name}</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Interviewer</dt>
                  <dd className="mt-0.5 flex items-center gap-2 font-medium text-zinc-900">
                    <Avatar name={d.host.name} size="xs" /> {d.host.name}
                  </dd>
                </div>
                <div>
                  <dt className="flex items-center gap-1.5 text-zinc-500"><CalendarDays className="size-3.5" /> Date</dt>
                  <dd className="mt-0.5 font-medium text-zinc-900">{start.toFormat('cccc, LLLL d, yyyy')}</dd>
                </div>
                <div>
                  <dt className="flex items-center gap-1.5 text-zinc-500"><Clock className="size-3.5" /> Time</dt>
                  <dd className="tabular mt-0.5 font-medium text-zinc-900">
                    {start.toFormat('h:mm a')} – {end.toFormat('h:mm a')} <span className="font-normal text-zinc-500">({formatDuration(end.diff(start, 'minutes').minutes)})</span>
                  </dd>
                </div>
                <div>
                  <dt className="flex items-center gap-1.5 text-zinc-500"><Globe2 className="size-3.5" /> Time zones</dt>
                  <dd className="mt-0.5 space-y-0.5 text-zinc-700">
                    <p>Interviewer: {hostStart.toFormat('h:mm a')} {i.timezone.replace(/_/g, ' ')}</p>
                    <p>Candidate: {candStart.toFormat('h:mm a')} {i.candidateTimezone.replace(/_/g, ' ')}</p>
                  </dd>
                </div>
                <div>
                  <dt className="flex items-center gap-1.5 text-zinc-500">{i.locationType === 'zoom' ? <Video className="size-3.5" /> : <MapPin className="size-3.5" />} Location</dt>
                  <dd className="mt-0.5 font-medium text-zinc-900">
                    {i.locationType === 'zoom' ? (
                      d.meeting?.joinUrl && !cancelled ? (
                        <a href={d.meeting.joinUrl} target="_blank" rel="noreferrer" className="break-all text-brand-700 hover:underline">
                          {d.meeting.joinUrl}
                        </a>
                      ) : (
                        'Zoom'
                      )
                    ) : (
                      locationLabel(i.locationType, i.locationDetails)
                    )}
                    {d.meeting?.passcode && !cancelled && <span className="block text-xs font-normal text-zinc-500">Passcode {d.meeting.passcode}</span>}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Booked</dt>
                  <dd className="mt-0.5 text-zinc-700">
                    {DateTime.fromISO(i.createdAt, { zone }).toFormat('LLL d, yyyy, h:mm a')} · {i.source.replace('_', ' ')}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Buffers</dt>
                  <dd className="mt-0.5 text-zinc-700">
                    {i.bufferBeforeMinutes} min before · {i.bufferAfterMinutes} min after
                  </dd>
                </div>
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Candidate" />
            <CardBody>
              <ul className="grid gap-3 text-sm sm:grid-cols-2">
                <li className="flex items-center gap-2.5 text-zinc-700">
                  <Mail className="size-4 text-zinc-400" />
                  <a href={`mailto:${d.candidate.email}`} className="hover:underline">
                    {d.candidate.email}
                  </a>
                </li>
                {d.candidate.phone && (
                  <li className="flex items-center gap-2.5 text-zinc-700">
                    <Phone className="size-4 text-zinc-400" /> {d.candidate.phone}
                  </li>
                )}
                {d.candidate.company && (
                  <li className="flex items-center gap-2.5 text-zinc-700">
                    <Building2 className="size-4 text-zinc-400" /> {d.candidate.company}
                  </li>
                )}
                {d.candidate.linkedinUrl && (
                  <li className="flex items-center gap-2.5">
                    <Briefcase className="size-4 text-zinc-400" />
                    <a href={d.candidate.linkedinUrl} target="_blank" rel="noreferrer noopener" className="truncate text-brand-700 hover:underline">
                      LinkedIn profile
                    </a>
                  </li>
                )}
                {d.candidate.resumeUrl && (
                  <li className="flex items-center gap-2.5">
                    <FileText className="size-4 text-zinc-400" />
                    <a href={d.candidate.resumeUrl} target="_blank" rel="noreferrer noopener" className="text-brand-700 hover:underline">
                      Résumé <ExternalLink className="inline size-3" />
                    </a>
                  </li>
                )}
              </ul>
              {i.responses.length > 0 && (
                <div className="mt-5 space-y-3 border-t border-zinc-100 pt-4">
                  {i.responses.map((r) => (
                    <div key={r.questionId}>
                      <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">{r.label}</p>
                      <p className="mt-1 whitespace-pre-line text-sm text-zinc-800">{r.answer}</p>
                    </div>
                  ))}
                </div>
              )}
              {d.otherInterviews.length > 0 && (
                <div className="mt-5 border-t border-zinc-100 pt-4">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">Other interviews with this candidate</p>
                  <ul className="space-y-1.5 text-sm">
                    {d.otherInterviews.map((o) => (
                      <li key={o.id} className="flex items-center justify-between gap-3">
                        <Link href={`/interviews/${o.id}`} className="text-zinc-700 hover:underline">
                          {o.eventTypeName} · {DateTime.fromISO(o.startAt, { zone }).toFormat('LLL d, yyyy')}
                        </Link>
                        <InterviewStatusBadge status={o.status} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title={<span className="inline-flex items-center gap-2"><History className="size-4 text-zinc-400" /> History</span>} description="Every change to this interview, including original times." />
            <ol className="relative space-y-0 px-5 py-4">
              {d.timeline.map((t, idx) => (
                <li key={t.id} className="relative flex gap-3 pb-4 last:pb-0">
                  {idx < d.timeline.length - 1 && <span className="absolute left-[7px] top-4 h-full w-px bg-zinc-200" aria-hidden="true" />}
                  <span className={`relative mt-1 size-[15px] shrink-0 rounded-full border-2 border-white ring-1 ${t.action.includes('failure') ? 'bg-rose-400 ring-rose-200' : t.action.includes('cancel') ? 'bg-rose-400 ring-rose-200' : t.action.includes('reschedul') ? 'bg-violet-400 ring-violet-200' : 'bg-brand-400 ring-brand-200'}`} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-900">
                      {ACTION_LABELS[t.action] ?? t.action} <span className="font-normal text-zinc-500">by {t.actorName}</span>
                    </p>
                    {describe(t, zone) && <p className="mt-0.5 break-words text-sm text-zinc-600">{describe(t, zone)}</p>}
                    <p className="mt-0.5 text-xs text-zinc-400">{DateTime.fromISO(t.createdAt, { zone }).toFormat('LLL d, yyyy · h:mm a')}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Integrations" description="Synchronization status" />
            <CardBody className="space-y-4">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <p className="flex items-center gap-2 text-sm font-medium text-zinc-900">
                    <Video className="size-4 text-zinc-400" /> Zoom meeting
                  </p>
                  <SyncBadge status={d.meeting?.status ?? null} />
                </div>
                {d.meeting ? (
                  <div className="mt-2 space-y-1 text-xs text-zinc-500">
                    {d.meeting.externalMeetingId && <p>Meeting ID {d.meeting.externalMeetingId}</p>}
                    {d.meeting.syncedAt && <p>Last synced {DateTime.fromISO(d.meeting.syncedAt, { zone }).toRelative()}</p>}
                    {d.meeting.lastError && d.meeting.status !== 'synced' && <p className="text-rose-600">{d.meeting.lastError}</p>}
                    {(d.meeting.status === 'failed' || d.meeting.status === 'deleted_externally' || d.meeting.status === 'pending') && !cancelled && (
                      <div className="pt-1">
                        <RetrySyncButton interviewId={i.id} label={d.meeting.status === 'deleted_externally' ? 'Recreate meeting' : 'Retry now'} />
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-zinc-500">Not a Zoom interview.</p>
                )}
              </div>
              <div className="border-t border-zinc-100 pt-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="flex items-center gap-2 text-sm font-medium text-zinc-900">
                    <CalendarDays className="size-4 text-zinc-400" /> Google Calendar
                  </p>
                  <SyncBadge status={d.calendarEvent?.status ?? null} />
                </div>
                {d.calendarEvent ? (
                  <div className="mt-2 space-y-1 text-xs text-zinc-500">
                    {d.calendarEvent.externalCalendarId && <p className="truncate">Calendar: {d.calendarEvent.externalCalendarId}</p>}
                    {d.calendarEvent.syncedAt && <p>Last synced {DateTime.fromISO(d.calendarEvent.syncedAt, { zone }).toRelative()}</p>}
                    {d.calendarEvent.htmlLink && d.calendarEvent.status === 'synced' && (
                      <a href={d.calendarEvent.htmlLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline">
                        Open event <ExternalLink className="size-3" />
                      </a>
                    )}
                    {d.calendarEvent.lastError && d.calendarEvent.status !== 'synced' && <p className="text-rose-600">{d.calendarEvent.lastError}</p>}
                    {(d.calendarEvent.status === 'failed' || d.calendarEvent.status === 'deleted_externally' || d.calendarEvent.status === 'pending') && !cancelled && (
                      <div className="pt-1">
                        <RetrySyncButton interviewId={i.id} label={d.calendarEvent.status === 'deleted_externally' ? 'Recreate event' : 'Retry now'} />
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-zinc-500">The interviewer hasn’t connected Google Calendar.</p>
                )}
              </div>
            </CardBody>
          </Card>

          {d.reschedules.length > 0 && (
            <Card>
              <CardHeader title="Original schedule" />
              <ul className="divide-y divide-zinc-100">
                {d.reschedules.map((r) => (
                  <li key={r.id} className="px-5 py-3 text-sm">
                    <p className="text-zinc-400 line-through">{DateTime.fromISO(r.previousStartAt, { zone }).toFormat('ccc, LLL d · h:mm a')}</p>
                    <p className="font-medium text-zinc-800">→ {DateTime.fromISO(r.newStartAt, { zone }).toFormat('ccc, LLL d · h:mm a')}</p>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      by {r.actorName} · {DateTime.fromISO(r.createdAt, { zone }).toFormat('LLL d')}
                      {r.reason && ` · “${r.reason}”`}
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card>
            <CardHeader title="Notifications" description="Emails for this interview" />
            {d.notifications.length === 0 ? (
              <CardBody className="text-sm text-zinc-500">No notifications.</CardBody>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {d.notifications.map((n) => (
                  <li key={n.id} className="flex items-start justify-between gap-3 px-5 py-2.5 text-sm">
                    <div className="min-w-0">
                      <p className="truncate text-zinc-800">{NOTIFICATION_LABELS[n.type] ?? n.type}</p>
                      <p className="truncate text-xs text-zinc-500">
                        {n.recipientEmail} · {DateTime.fromISO(n.sentAt ?? n.scheduledFor, { zone }).toFormat('LLL d, h:mm a')}
                      </p>
                      {n.status === 'failed' && n.lastError && <p className="text-xs text-rose-600">{n.lastError}</p>}
                    </div>
                    <Badge tone={n.status === 'sent' ? 'green' : n.status === 'failed' ? 'red' : n.status === 'skipped' ? 'neutral' : 'blue'}>{n.status === 'queued' ? 'Scheduled' : n.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
