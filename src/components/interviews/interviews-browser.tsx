import { CalendarDays, List, Plus, SearchX } from 'lucide-react';
import Link from 'next/link';
import { CalendarView } from '@/components/calendar/calendar-view';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Pagination } from '@/components/ui/pagination';
import { LinkTabs } from '@/components/ui/tabs';
import { cn } from '@/lib/cn';
import type { AuthContext } from '@/server/auth/session';
import { canViewAllInterviews } from '@/server/authz/policy';
import { listEventTypeOptions, listInterviewers, listInterviews, type InterviewFilters as Filters, type InterviewView } from '@/server/services/interviews-service';
import { InterviewFilters } from './interview-filters';
import { InterviewTable } from './interview-table';

const VIEWS: { key: InterviewView; label: string }[] = [
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'past', label: 'Past' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'rescheduled', label: 'Rescheduled' },
  { key: 'all', label: 'All' },
];

type SP = Record<string, string | undefined>;

/** Shared list/calendar browser for /interviews and /admin/interviews. */
export async function InterviewsBrowser({ auth, sp, basePath, admin = false }: { auth: AuthContext; sp: SP; basePath: string; admin?: boolean }) {
  const canTeam = canViewAllInterviews(auth);
  const scope: 'mine' | 'team' = admin ? 'team' : canTeam && (sp.scope ?? (auth.membership.role === 'recruiter' ? 'team' : 'mine')) === 'team' ? 'team' : 'mine';
  const display = sp.display === 'calendar' ? 'calendar' : 'list';
  const view = (VIEWS.some((v) => v.key === sp.view) ? sp.view : 'upcoming') as InterviewView;
  const filters: Filters = {
    view,
    q: sp.q,
    interviewerId: sp.interviewerId,
    eventTypeId: sp.eventTypeId,
    status: ['scheduled', 'rescheduled', 'cancelled', 'completed', 'no_show'].includes(sp.status ?? '') ? (sp.status as Filters['status']) : undefined,
    from: sp.from && /^\d{4}-\d{2}-\d{2}$/.test(sp.from) ? sp.from : undefined,
    to: sp.to && /^\d{4}-\d{2}-\d{2}$/.test(sp.to) ? sp.to : undefined,
    sort: ['start_asc', 'start_desc', 'created_desc'].includes(sp.sort ?? '') ? (sp.sort as Filters['sort']) : undefined,
    page: Number(sp.page) > 0 ? Number(sp.page) : 1,
    pageSize: 25,
    scope,
  };
  const [result, interviewers, eventTypes] = await Promise.all([
    display === 'list' ? listInterviews(auth, filters) : Promise.resolve(null),
    listInterviewers(auth),
    listEventTypeOptions(auth),
  ]);

  const href = (patch: SP) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...patch })) if (v) next.set(k, v);
    const s = next.toString();
    return s ? `${basePath}?${s}` : basePath;
  };

  return (
    <>
      <PageHeader
        title={admin ? 'All interviews' : 'Scheduled interviews'}
        description={admin ? 'Every interview across your organization.' : scope === 'team' ? 'Interviews across your team.' : 'Interviews where you are the interviewer.'}
        actions={
          <>
            {canTeam && !admin && (
              <div className="inline-flex rounded-lg bg-zinc-200/60 p-0.5 text-sm">
                {(['mine', 'team'] as const).map((v) => (
                  <Link key={v} href={href({ scope: v, page: undefined, interviewerId: undefined })} className={cn('rounded-md px-3 py-1 font-medium', scope === v ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800')}>
                    {v === 'mine' ? 'Mine' : 'Team'}
                  </Link>
                ))}
              </div>
            )}
            <div className="inline-flex rounded-lg border border-zinc-200 bg-white p-0.5 shadow-sm">
              <Link href={href({ display: undefined })} aria-label="List view" className={cn('rounded-md p-1.5', display === 'list' ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-400 hover:text-zinc-700')}>
                <List className="size-4" />
              </Link>
              <Link href={href({ display: 'calendar' })} aria-label="Calendar view" className={cn('rounded-md p-1.5', display === 'calendar' ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-400 hover:text-zinc-700')}>
                <CalendarDays className="size-4" />
              </Link>
            </div>
            <Button asChild>
              <Link href="/interviews/new">
                <Plus /> Schedule interview
              </Link>
            </Button>
          </>
        }
      />
      {display === 'calendar' ? (
        <CalendarView scope={scope} timezone={auth.user.timezone} showInterviewer={scope === 'team'} interviewers={scope === 'team' ? interviewers : []} />
      ) : (
        <Card>
          <div className="px-4 pt-3">
            <LinkTabs tabs={VIEWS.map((v) => ({ key: v.key, label: v.label, href: href({ view: v.key, page: undefined }) }))} active={view} />
          </div>
          <InterviewFilters interviewers={interviewers} eventTypes={eventTypes} showInterviewer={scope === 'team'} />
          <InterviewTable
            items={result!.items}
            zone={auth.user.timezone}
            showInterviewer={scope === 'team'}
            emptyState={
              <EmptyState
                icon={<SearchX />}
                title="No interviews found"
                description={filters.q || filters.status || filters.eventTypeId || filters.interviewerId ? 'Try adjusting your search or filters.' : 'Interviews matching this view will appear here.'}
              />
            }
          />
          <div className="border-t border-zinc-100 px-4">
            <Pagination page={result!.page} pageSize={result!.pageSize} total={result!.total} hrefFor={(p) => href({ page: String(p) })} />
          </div>
        </Card>
      )}
    </>
  );
}
