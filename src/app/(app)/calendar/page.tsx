import type { Metadata } from 'next';
import { CalendarView } from '@/components/calendar/calendar-view';
import { PageHeader } from '@/components/ui/page-header';
import { requirePageAuth } from '@/server/auth/page-guards';
import { canViewAllInterviews } from '@/server/authz/policy';
import { listInterviewers } from '@/server/services/interviews-service';
import Link from 'next/link';
import { cn } from '@/lib/cn';

export const metadata: Metadata = { title: 'Calendar' };

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ scope?: string }> }) {
  const auth = await requirePageAuth('/calendar');
  const { scope: s } = await searchParams;
  const canTeam = canViewAllInterviews(auth);
  const scope = canTeam && s === 'team' ? 'team' : 'mine';
  const interviewers = scope === 'team' ? await listInterviewers(auth) : [];
  return (
    <>
      <PageHeader
        title="Calendar"
        description="Your interviews alongside busy time from your connected calendar."
        actions={
          canTeam && (
            <div className="inline-flex rounded-lg bg-zinc-200/60 p-0.5 text-sm">
              {(['mine', 'team'] as const).map((v) => (
                <Link key={v} href={v === 'mine' ? '/calendar' : '/calendar?scope=team'} className={cn('rounded-md px-3 py-1 font-medium', scope === v ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800')}>
                  {v === 'mine' ? 'My calendar' : 'Team'}
                </Link>
              ))}
            </div>
          )
        }
      />
      <CalendarView key={scope} scope={scope} timezone={auth.user.timezone} showInterviewer={scope === 'team'} interviewers={interviewers} />
    </>
  );
}
