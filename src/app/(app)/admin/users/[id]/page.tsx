import { DateTime } from 'luxon';
import { ArrowLeft, ExternalLink, Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActivityList } from '@/components/admin/activity-list';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { formatDuration } from '@/lib/format';
import { requireAdminPage } from '@/server/auth/page-guards';
import { ROLE_LABELS } from '@/server/authz/policy';
import { appUrl } from '@/server/config/env';
import { isAppError } from '@/server/http/errors';
import { getMemberDetails } from '@/server/services/team-service';

export const metadata: Metadata = { title: 'User details' };

export default async function AdminUserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminPage();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let d: Awaited<ReturnType<typeof getMemberDetails>>;
  try {
    d = await getMemberDetails(auth, id);
  } catch (err) {
    if (isAppError(err) && err.status === 404) notFound();
    throw err;
  }
  const m = d.member;
  const zone = auth.user.timezone;
  return (
    <>
      <Link href="/admin/users" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-zinc-500 hover:text-zinc-800">
        <ArrowLeft className="size-4" /> Users
      </Link>
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <Avatar name={m.name} size="xl" />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{m.name}</h1>
          <p className="text-sm text-zinc-500">
            {m.email}
            {m.title && ` · ${m.title}`}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge tone={m.role === 'admin' ? 'violet' : m.role === 'recruiter' ? 'blue' : 'neutral'}>{ROLE_LABELS[m.role]}</Badge>
            <Badge tone={m.status === 'active' ? 'green' : m.status === 'invited' ? 'amber' : 'red'} dot>
              {m.status}
            </Badge>
            {!m.emailVerified && <Badge tone="amber">Email unverified</Badge>}
          </div>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="secondary">
            <Link href={`/admin/interviews?interviewerId=${m.userId}&view=all`}>View interviews</Link>
          </Button>
          <Button asChild variant="secondary">
            <a href={appUrl(`/schedule/${m.username}`)} target="_blank" rel="noreferrer">
              <ExternalLink /> Booking page
            </a>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Upcoming" value={d.stats.upcoming} tone="brand" />
        <StatCard label="Total" value={d.stats.total} />
        <StatCard label="Completed" value={d.stats.completed} />
        <StatCard label="Rescheduled" value={d.stats.rescheduled} />
        <StatCard label="Cancelled" value={d.stats.cancelled} />
        <StatCard label="No-shows" value={d.stats.noShow} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Integrations" />
            {d.integrations.length === 0 ? (
              <CardBody className="text-sm text-zinc-500">No integrations connected.</CardBody>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {d.integrations.map((i) => (
                  <li key={i.provider} className="flex items-start justify-between gap-3 px-5 py-3">
                    <div>
                      <p className="text-sm font-medium text-zinc-900">{i.provider === 'zoom' ? 'Zoom' : 'Google Calendar'}</p>
                      <p className="text-xs text-zinc-500">
                        {i.accountEmail} · since {DateTime.fromISO(i.connectedAt, { zone }).toFormat('LLL d, yyyy')}
                      </p>
                      {i.status === 'error' && i.lastError && <p className="mt-1 text-xs text-rose-600">{i.lastError}</p>}
                    </div>
                    <Badge tone={i.status === 'active' ? 'green' : 'red'}>{i.status === 'active' ? 'Connected' : 'Error'}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader
              title="Event types"
              action={
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/event-types/new?host=${m.userId}`}>
                    <Plus /> Create for {m.name.split(' ')[0]}
                  </Link>
                </Button>
              }
            />
            {d.eventTypes.length === 0 ? (
              <CardBody className="text-sm text-zinc-500">No event types.</CardBody>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {d.eventTypes.map((e) => (
                  <li key={e.id} className="flex items-center justify-between px-5 py-3">
                    <Link href={`/event-types/${e.id}`} className="text-sm font-medium text-zinc-900 hover:underline">
                      {e.name}
                    </Link>
                    <span className="flex items-center gap-2 text-xs text-zinc-500">
                      {formatDuration(e.durationMinutes)}
                      <Badge tone={e.isActive ? 'green' : 'neutral'}>{e.isActive ? 'On' : 'Off'}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <Card>
          <CardHeader title="Activity" description={`Joined ${DateTime.fromISO(m.joinedAt, { zone }).toFormat('LLL d, yyyy')} · last sign-in ${m.lastLoginAt ? DateTime.fromISO(m.lastLoginAt).toRelative() : 'never'}`} />
          <ActivityList
            items={d.activity.map((a) => ({ id: a.id, action: a.action, actorType: a.actorType, actorName: a.actorLabel ?? (a.actorUserId === m.userId ? m.name : 'Admin'), resourceType: a.resourceType, resourceId: a.resourceId, metadata: a.metadata, createdAt: a.createdAt.toISOString() }))}
            zone={zone}
            compact
          />
        </Card>
      </div>
    </>
  );
}
