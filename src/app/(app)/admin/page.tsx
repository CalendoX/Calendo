import { DateTime } from 'luxon';
import { AlertTriangle, CalendarCheck2, CalendarClock, CalendarX2, Plug, UserCheck, Users } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ActivityList } from '@/components/admin/activity-list';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { StatCard } from '@/components/ui/stat-card';
import { requireAdminPage } from '@/server/auth/page-guards';
import { getAdminOverview } from '@/server/services/interviews-service';

export const metadata: Metadata = { title: 'Admin overview' };

export default async function AdminOverviewPage() {
  const auth = await requireAdminPage();
  const o = await getAdminOverview(auth);
  const zone = auth.user.timezone;
  const max = Math.max(1, ...o.volume.map((v) => v.scheduled + v.cancelled));
  const today = DateTime.now().setZone(zone).toISODate();
  const connected = (p: string) => o.integrations.filter((i) => i.provider === p && i.status === 'active').reduce((a, b) => a + b.n, 0);
  const failures = o.syncFailures.meetings + o.syncFailures.calendar + o.syncFailures.emails;
  return (
    <>
      <PageHeader title="Admin overview" description={`Scheduling activity across ${auth.organization.name}.`} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <StatCard label="Total users" value={o.users.total} icon={<Users />} href="/admin/users" hint={`${o.users.invited} invited`} />
        <StatCard label="Active users" value={o.users.activeLast30} icon={<UserCheck />} tone="brand" href="/admin/users?status=active" hint="Signed in last 30 days" />
        <StatCard label="Total interviews" value={o.interviews.total} icon={<CalendarCheck2 />} href="/admin/interviews?view=all" />
        <StatCard label="Upcoming" value={o.interviews.upcoming} icon={<CalendarClock />} tone="brand" href="/admin/interviews" />
        <StatCard label="Today" value={o.interviews.today} icon={<CalendarClock />} href="/admin/interviews?view=today" />
        <StatCard label="Cancelled" value={o.interviews.cancelled} icon={<CalendarX2 />} tone={o.interviews.cancelled ? 'danger' : 'neutral'} href="/admin/interviews?view=cancelled" />
        <StatCard label="Integrations" value={connected('google_calendar') + connected('zoom')} icon={<Plug />} href="/admin/integrations" hint={`${connected('google_calendar')} Google · ${connected('zoom')} Zoom`} />
      </div>

      {failures > 0 && (
        <Card className="mt-6 border-amber-200 bg-amber-50/60">
          <CardBody className="flex flex-wrap items-center gap-3 text-sm text-amber-900">
            <AlertTriangle className="size-4 text-amber-600" />
            <span>
              <strong>{o.syncFailures.meetings}</strong> Zoom and <strong>{o.syncFailures.calendar}</strong> calendar sync failures on upcoming interviews, <strong>{o.syncFailures.emails}</strong> failed emails.
            </span>
            <Button asChild size="sm" variant="secondary" className="ml-auto">
              <Link href="/admin/integrations">Review</Link>
            </Button>
          </CardBody>
        </Card>
      )}

      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader title="Interview volume" description="Past two weeks and the next two weeks, by interview date" />
            <CardBody>
              <div className="flex h-44 items-end gap-1" role="img" aria-label="Interviews per day">
                {o.volume.map((v) => (
                  <div key={v.date} className="group relative flex h-full flex-1 flex-col justify-end" title={`${DateTime.fromISO(v.date).toFormat('LLL d')}: ${v.scheduled} scheduled, ${v.cancelled} cancelled`}>
                    <div className="w-full rounded-t-sm bg-rose-300" style={{ height: `${(v.cancelled / max) * 100}%` }} />
                    <div className={`w-full ${v.cancelled ? '' : 'rounded-t-sm'} ${v.date > today! ? 'bg-brand-300' : 'bg-brand-600'}`} style={{ height: `${(v.scheduled / max) * 100}%`, minHeight: v.scheduled ? 3 : 0 }} />
                    {v.date === today && <span className="absolute -bottom-5 left-1/2 -translate-x-1/2 text-[10px] font-semibold text-brand-700">Today</span>}
                  </div>
                ))}
              </div>
              <div className="mt-7 flex items-center gap-4 text-xs text-zinc-500">
                <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-brand-600" /> Held / scheduled</span>
                <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-brand-300" /> Upcoming</span>
                <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-rose-300" /> Cancelled</span>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Interviewer load" description="Upcoming interviews and interviews in the last 30 days" />
            {o.load.length === 0 ? (
              <CardBody className="text-sm text-zinc-500">No interviews yet.</CardBody>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {o.load.map((l) => {
                  const top = Math.max(1, ...o.load.map((x) => x.upcoming));
                  return (
                    <li key={l.hostUserId} className="flex items-center gap-4 px-5 py-3">
                      <Link href={`/admin/users/${l.hostUserId}`} className="w-40 truncate text-sm font-medium text-zinc-900 hover:underline">
                        {l.name}
                      </Link>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-100">
                        <div className="h-full rounded-full bg-brand-500" style={{ width: `${(l.upcoming / top) * 100}%` }} />
                      </div>
                      <span className="tabular w-24 text-right text-xs text-zinc-500">
                        {l.upcoming} upcoming · {l.last30} held
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>

        <Card>
          <CardHeader title="Recent activity" action={<Button asChild variant="ghost" size="sm"><Link href="/admin/audit-log">Audit log</Link></Button>} />
          <ActivityList items={o.recentActivity} zone={zone} compact />
        </Card>
      </div>
    </>
  );
}
