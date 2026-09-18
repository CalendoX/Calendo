import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { ScheduleForCandidate } from '@/components/interviews/schedule-for-candidate';
import { PageHeader } from '@/components/ui/page-header';
import { requirePageAuth } from '@/server/auth/page-guards';
import { canViewAllInterviews } from '@/server/authz/policy';
import { listEventTypes } from '@/server/services/event-types-service';

export const metadata: Metadata = { title: 'Schedule interview' };

export default async function NewInterviewPage() {
  const auth = await requirePageAuth('/interviews/new');
  const types = await listEventTypes(auth, { scope: canViewAllInterviews(auth) ? 'all' : 'mine' });
  return (
    <>
      <Link href="/interviews" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-zinc-500 hover:text-zinc-800">
        <ArrowLeft className="size-4" /> Scheduled interviews
      </Link>
      <PageHeader title="Schedule an interview" description="Book a time on a candidate’s behalf. They’ll receive the same confirmation, calendar invite and Zoom link as a self-booked interview." />
      <ScheduleForCandidate
        eventTypes={types.map((t) => ({ id: t.id, name: t.name, durationMinutes: t.durationMinutes, host: { name: t.host.name }, isActive: t.isActive }))}
        viewerTimezone={auth.user.timezone}
      />
    </>
  );
}
