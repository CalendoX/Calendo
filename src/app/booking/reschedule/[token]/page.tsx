import { DateTime } from 'luxon';
import type { Metadata } from 'next';
import { CandidateReschedule } from '@/components/scheduling/candidate-manage';
import { OrgBrand, PublicFrame, PublicMessage } from '@/components/scheduling/public-frame';
import { formatDuration } from '@/lib/format';
import { getCandidateBooking } from '@/server/services/public-service';

export const metadata: Metadata = { title: 'Reschedule your interview' };

export default async function ReschedulePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await getCandidateBooking(token, 'reschedule');
  if (!result.ok) {
    const messages = {
      not_found: ['Link not found', 'Please check the reschedule link in your email.'],
      expired: ['This link has expired', 'Interviews can’t be rescheduled online once they’ve started. Please contact your recruiter.'],
      revoked: ['This interview can’t be rescheduled', 'It may have been cancelled. Please check your email or contact your recruiter.'],
    } as const;
    const [title, body] = messages[result.reason];
    return <PublicMessage title={title}>{body}</PublicMessage>;
  }
  const v = result.view;
  if (!v.policy.canReschedule) {
    return <PublicMessage title="Rescheduling isn’t available">{v.policy.reason ?? 'Online rescheduling is turned off for this interview. Please contact your recruiter.'}</PublicMessage>;
  }
  const start = DateTime.fromISO(v.startAt, { zone: v.candidateTimezone });
  return (
    <PublicFrame>
      <div className="overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-card">
        <div className="h-1" style={{ backgroundColor: v.organization.brandColor }} />
        <div className="grid md:grid-cols-[300px_1fr]">
          <aside className="space-y-5 border-b border-zinc-100 p-6 sm:p-8 md:border-b-0 md:border-r">
            <OrgBrand name={v.organization.name} logoUrl={v.organization.logoUrl} />
            <div>
              <p className="text-sm font-medium text-zinc-500">Rescheduling</p>
              <h1 className="mt-1 text-xl font-semibold text-zinc-900">{v.eventType.name}</h1>
              <p className="mt-1 text-sm text-zinc-500">
                with {v.host.name} · {formatDuration(v.eventType.durationMinutes)}
              </p>
            </div>
            <div className="rounded-xl bg-zinc-50 p-4 text-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Currently</p>
              <p className="mt-1 font-medium text-zinc-800">{start.toFormat('cccc, LLLL d')}</p>
              <p className="text-zinc-600">
                {start.toFormat('h:mm a')} ({start.toFormat('ZZZZ')})
              </p>
            </div>
          </aside>
          <section className="p-6 sm:p-8">
            <h2 className="mb-6 text-lg font-semibold text-zinc-900">Pick a new time</h2>
            <CandidateReschedule token={token} currentStart={v.startAt} accent={v.organization.brandColor} />
          </section>
        </div>
      </div>
    </PublicFrame>
  );
}
