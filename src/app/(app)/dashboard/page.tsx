import { DateTime } from 'luxon';
import {
  AlertTriangle,
  ArrowRight,
  CalendarCheck2,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  CalendarX2,
  CheckCircle2,
  Circle,
  Plus,
  Repeat2,
  Sparkles,
  Video,
} from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { InterviewTable } from '@/components/interviews/interview-table';
import { InterviewStatusBadge } from '@/components/interviews/status-badge';
import { Alert } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { StatCard } from '@/components/ui/stat-card';
import { cn } from '@/lib/cn';
import { firstName } from '@/lib/format';
import { requirePageAuth } from '@/server/auth/page-guards';
import { canViewAllInterviews } from '@/server/authz/policy';
import { appUrl } from '@/server/config/env';
import { listEventTypes } from '@/server/services/event-types-service';
import { getDashboard } from '@/server/services/interviews-service';

export const metadata: Metadata = { title: 'Dashboard' };

function greeting(zone: string) {
  const h = DateTime.now().setZone(zone).hour;
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ scope?: string; welcome?: string }> }) {
  const auth = await requirePageAuth('/dashboard');
  const sp = await searchParams;
  const canTeam = canViewAllInterviews(auth);
  const scope = canTeam && sp.scope === 'team' ? 'team' : 'mine';
  const [data, myEventTypes] = await Promise.all([getDashboard(auth, scope), listEventTypes(auth, { scope: 'mine' })]);
  const zone = auth.user.timezone;
  const s = data.stats;
  const google = data.integrations.find((i) => i.provider === 'google_calendar');
  const zoom = data.integrations.find((i) => i.provider === 'zoom');
  const bookingPage = appUrl(`/schedule/${auth.user.username}`);

  const checklist = [
    { done: google?.status === 'active', label: 'Connect Google Calendar', hint: 'So candidates never see times you’re busy.', href: '/integrations' },
    { done: zoom?.status === 'active', label: 'Connect Zoom', hint: 'Meetings are created automatically for each interview.', href: '/integrations' },
    { done: myEventTypes.length > 0, label: 'Create an interview type', hint: 'e.g. “Technical Interview”, 60 minutes.', href: '/event-types/new' },
    { done: s.total > 0, label: 'Share your scheduling link', hint: 'Send it to a candidate or add it to your emails.', href: '/event-types' },
  ];
  const showChecklist = checklist.some((c) => !c.done);
  const next = data.next;

  return (
    <>
      <PageHeader
        title={`${greeting(zone)}, ${firstName(auth.user.name)}`}
        description={`Here’s what’s happening with ${scope === 'team' ? 'your team’s' : 'your'} interviews.`}
        actions={
          <>
            {canTeam && (
              <div className="inline-flex rounded-lg bg-zinc-200/60 p-0.5 text-sm">
                {(['mine', 'team'] as const).map((v) => (
                  <Link
                    key={v}
                    href={v === 'mine' ? '/dashboard' : '/dashboard?scope=team'}
                    className={cn('rounded-md px-3 py-1 font-medium', scope === v ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800')}
                  >
                    {v === 'mine' ? 'My interviews' : 'Team'}
                  </Link>
                ))}
              </div>
            )}
            <CopyButton value={bookingPage} label="Copy booking page" />
            <Button asChild>
              <Link href="/event-types/new">
                <Plus /> New event type
              </Link>
            </Button>
          </>
        }
      />

      {sp.welcome && (
        <Alert tone="success" title="Welcome to Slate" className="mb-6">
          Your account is ready. Follow the checklist below to publish your first scheduling link.
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Today" value={s.today} icon={<CalendarClock />} tone="brand" href="/interviews?view=today" hint="Interviews today" />
        <StatCard label="This week" value={s.thisWeek} icon={<CalendarRange />} href="/interviews?view=week" hint="Mon – Sun" />
        <StatCard label="Upcoming" value={s.upcoming} icon={<CalendarCheck2 />} href="/interviews?view=upcoming" hint="Scheduled ahead" />
        <StatCard label="Total scheduled" value={s.total} icon={<CalendarDays />} href="/interviews?view=all" hint="All time" />
        <StatCard label="Cancellations" value={s.cancelled30d} icon={<CalendarX2 />} tone={s.cancelled30d ? 'danger' : 'neutral'} href="/interviews?view=cancelled" hint="Last 30 days" />
        <StatCard label="Rescheduled" value={s.rescheduled} icon={<Repeat2 />} href="/interviews?view=rescheduled" hint="Moved at least once" />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-6">
          {next && (
            <Card className="overflow-hidden">
              <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center">
                <div className="flex min-w-[110px] flex-col items-center justify-center rounded-xl bg-brand-50 px-4 py-3 text-brand-800">
                  <span className="text-xs font-semibold uppercase tracking-wide">{DateTime.fromISO(next.startAt, { zone }).toFormat('ccc')}</span>
                  <span className="tabular text-3xl font-semibold leading-tight">{DateTime.fromISO(next.startAt, { zone }).toFormat('d')}</span>
                  <span className="text-xs">{DateTime.fromISO(next.startAt, { zone }).toFormat('LLL')}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">Next interview · {DateTime.fromISO(next.startAt).toRelative()}</p>
                  <p className="mt-1 truncate text-lg font-semibold text-zinc-900">
                    {next.eventType.name} with {next.candidate.name}
                  </p>
                  <p className="tabular mt-0.5 text-sm text-zinc-500">
                    {DateTime.fromISO(next.startAt, { zone }).toFormat('h:mm a')} – {DateTime.fromISO(next.endAt, { zone }).toFormat('h:mm a ZZZZ')} · Interviewer: {next.host.name}
                  </p>
                  <div className="mt-2">
                    <InterviewStatusBadge status={next.status} />
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  {next.locationType === 'zoom' && next.meetingStatus === 'synced' && (
                    <Button asChild variant="secondary">
                      <a href={`/api/interviews/${next.id}/zoom/start`} target="_blank" rel="noreferrer">
                        <Video /> Start Zoom
                      </a>
                    </Button>
                  )}
                  <Button asChild variant="secondary">
                    <Link href={`/interviews/${next.id}`}>
                      Details <ArrowRight />
                    </Link>
                  </Button>
                </div>
              </div>
            </Card>
          )}

          <Card>
            <CardHeader
              title="Upcoming interviews"
              description={`Times shown in ${zone.replace(/_/g, ' ')}`}
              action={
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/interviews?view=upcoming${scope === 'mine' ? '&scope=mine' : ''}`}>
                    View all <ArrowRight />
                  </Link>
                </Button>
              }
            />
            <InterviewTable
              items={data.upcoming}
              zone={zone}
              showInterviewer={scope === 'team'}
              emptyState={
                <EmptyState
                  icon={<CalendarDays />}
                  title="No upcoming interviews"
                  description="Share a scheduling link with a candidate — booked interviews appear here instantly."
                  action={
                    <Button asChild variant="secondary">
                      <Link href="/event-types">Get your scheduling links</Link>
                    </Button>
                  }
                />
              }
            />
          </Card>
        </div>

        <div className="space-y-6">
          {showChecklist && (
            <Card>
              <CardHeader title={<span className="inline-flex items-center gap-2"><Sparkles className="size-4 text-brand-600" /> Get set up</span>} description={`${checklist.filter((c) => c.done).length} of ${checklist.length} complete`} />
              <ul className="divide-y divide-zinc-100">
                {checklist.map((c) => (
                  <li key={c.label}>
                    <Link href={c.href} className="flex gap-3 px-5 py-3 hover:bg-zinc-50">
                      {c.done ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-brand-600" /> : <Circle className="mt-0.5 size-5 shrink-0 text-zinc-300" />}
                      <span>
                        <span className={cn('block text-sm font-medium', c.done ? 'text-zinc-400 line-through' : 'text-zinc-900')}>{c.label}</span>
                        {!c.done && <span className="block text-xs text-zinc-500">{c.hint}</span>}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card>
            <CardHeader title="Integrations" action={<Button asChild variant="ghost" size="sm"><Link href="/integrations">Manage</Link></Button>} />
            <CardBody className="space-y-3">
              {[
                { key: 'google_calendar', label: 'Google Calendar', row: google },
                { key: 'zoom', label: 'Zoom', row: zoom },
              ].map((i) => (
                <div key={i.key} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-900">{i.label}</p>
                    <p className="truncate text-xs text-zinc-500">{i.row ? (i.row.status === 'active' ? i.row.accountEmail : 'Reconnect required') : 'Not connected'}</p>
                  </div>
                  <span
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
                      i.row?.status === 'active' ? 'bg-emerald-50 text-emerald-700' : i.row ? 'bg-rose-50 text-rose-700' : 'bg-zinc-100 text-zinc-500',
                    )}
                  >
                    <span className="size-1.5 rounded-full bg-current" />
                    {i.row?.status === 'active' ? 'Connected' : i.row ? 'Error' : 'Off'}
                  </span>
                </div>
              ))}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Needs attention" description="Integration problems on upcoming interviews" />
            {data.needsAttention.length === 0 ? (
              <CardBody className="flex items-center gap-2 text-sm text-zinc-500">
                <CheckCircle2 className="size-4 text-emerald-600" /> Everything is in sync.
              </CardBody>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {data.needsAttention.map((i) => (
                  <li key={i.id}>
                    <Link href={`/interviews/${i.id}`} className="flex items-start gap-3 px-5 py-3 hover:bg-zinc-50">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-zinc-900">{i.candidate.name}</span>
                        <span className="block text-xs text-zinc-500">
                          {[i.meetingStatus === 'failed' && 'Zoom failed', i.meetingStatus === 'deleted_externally' && 'Zoom meeting deleted', i.calendarStatus === 'failed' && 'Calendar failed', i.calendarStatus === 'deleted_externally' && 'Calendar event deleted'].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="bg-gradient-to-br from-white to-brand-50/60">
            <CardBody>
              <div className="flex items-center gap-3">
                <Avatar name={auth.user.name} />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-900">Your booking page</p>
                  <p className="truncate text-xs text-zinc-500">{bookingPage.replace(/^https?:\/\//, '')}</p>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <CopyButton value={bookingPage} label="Copy" />
                <Button asChild variant="ghost" size="sm">
                  <a href={bookingPage} target="_blank" rel="noreferrer">
                    Preview
                  </a>
                </Button>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
