import { Star } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { AvailabilityEditor, NewScheduleButton } from '@/components/availability/availability-editor';
import { PageHeader } from '@/components/ui/page-header';
import { cn } from '@/lib/cn';
import { requirePageAuth } from '@/server/auth/page-guards';
import { listSchedules } from '@/server/services/schedules-service';

export const metadata: Metadata = { title: 'Availability' };

function summary(weekly: { weekday: number; intervals: { start: string; end: string }[] }[]) {
  const days = weekly.filter((d) => d.intervals.length);
  if (!days.length) return 'No weekly hours';
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const first = days[0].intervals.map((i) => `${i.start}–${i.end}`).join(', ');
  const same = days.every((d) => d.intervals.map((i) => `${i.start}–${i.end}`).join(', ') === first);
  return `${days.map((d) => names[d.weekday - 1]).join(', ')}${same ? ` · ${first}` : ''}`;
}

export default async function AvailabilityPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const auth = await requirePageAuth('/availability');
  const { id } = await searchParams;
  const schedules = await listSchedules(auth);
  const current = schedules.find((s) => s.id === id) ?? schedules.find((s) => s.isDefault) ?? schedules[0];
  return (
    <>
      <PageHeader title="Availability" description="When candidates can book interviews with you. Connected calendars are checked on top of these hours." actions={<NewScheduleButton timezone={auth.user.timezone} copyFromId={current?.id} />} />
      {schedules.length > 1 && (
        <div className="mb-6 flex gap-2 overflow-x-auto pb-1">
          {schedules.map((s) => (
            <Link
              key={s.id}
              href={`/availability?id=${s.id}`}
              className={cn('min-w-[200px] rounded-xl border bg-white px-4 py-3 shadow-card transition', s.id === current?.id ? 'border-brand-500 ring-1 ring-brand-500' : 'border-zinc-200 hover:border-zinc-300')}
            >
              <span className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900">
                {s.name} {s.isDefault && <Star className="size-3.5 fill-brand-500 text-brand-500" />}
              </span>
              <span className="mt-0.5 block truncate text-xs text-zinc-500">{summary(s.weekly)}</span>
              <span className="block text-xs text-zinc-400">{s.timezone.replace(/_/g, ' ')}</span>
            </Link>
          ))}
        </div>
      )}
      {current ? <AvailabilityEditor key={current.id} schedule={current} viewerTimezone={auth.user.timezone} /> : <p className="text-sm text-zinc-500">No schedules yet.</p>}
    </>
  );
}
