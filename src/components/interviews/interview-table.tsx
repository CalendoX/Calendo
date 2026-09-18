import { DateTime } from 'luxon';
import { CalendarDays, Video } from 'lucide-react';
import Link from 'next/link';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/cn';
import type { InterviewListItem } from '@/server/services/interviews-service';
import { InterviewStatusBadge, SyncBadge } from './status-badge';

function when(item: InterviewListItem, zone: string) {
  const s = DateTime.fromISO(item.startAt, { zone });
  const e = DateTime.fromISO(item.endAt, { zone });
  const today = DateTime.now().setZone(zone).startOf('day');
  const diff = Math.round(s.startOf('day').diff(today, 'days').days);
  const day = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : s.toFormat(Math.abs(diff) < 7 && diff > 0 ? 'cccc' : 'ccc, LLL d');
  return { day, date: s.toFormat('LLL d, yyyy'), time: `${s.toFormat('h:mm a')} – ${e.toFormat('h:mm a')}`, zone: s.toFormat('ZZZZ') };
}

/** Dense, scannable interview table (server-rendered). Times are shown in the viewer's zone. */
export function InterviewTable({ items, zone, showInterviewer = true, emptyState }: { items: InterviewListItem[]; zone: string; showInterviewer?: boolean; emptyState?: React.ReactNode }) {
  if (items.length === 0) return <>{emptyState}</>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-sm">
        <thead>
          <tr className="border-b border-zinc-100 text-left text-xs font-medium uppercase tracking-wide text-zinc-400">
            <th className="py-2.5 pl-5 pr-3 font-medium">When</th>
            <th className="px-3 py-2.5 font-medium">Candidate</th>
            <th className="px-3 py-2.5 font-medium">Interview</th>
            {showInterviewer && <th className="px-3 py-2.5 font-medium">Interviewer</th>}
            <th className="px-3 py-2.5 font-medium">Status</th>
            <th className="py-2.5 pl-3 pr-5 font-medium">Zoom · Calendar</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {items.map((i) => {
            const w = when(i, zone);
            const muted = i.status === 'cancelled';
            return (
              <tr key={i.id} className={cn('group relative transition-colors hover:bg-zinc-50/80', muted && 'text-zinc-400')}>
                <td className="whitespace-nowrap py-3 pl-5 pr-3">
                  <Link href={`/interviews/${i.id}`} className="after:absolute after:inset-0" aria-label={`Open interview with ${i.candidate.name}`}>
                    <span className={cn('block font-medium', muted ? 'text-zinc-400 line-through' : 'text-zinc-900')}>{w.day}</span>
                  </Link>
                  <span className="tabular block text-xs text-zinc-500">
                    {w.time} <span className="text-zinc-400">{w.zone}</span>
                  </span>
                </td>
                <td className="px-3 py-3">
                  <span className="flex items-center gap-2.5">
                    <Avatar name={i.candidate.name} size="sm" />
                    <span className="min-w-0">
                      <span className={cn('block truncate font-medium', muted ? 'text-zinc-500' : 'text-zinc-900')}>{i.candidate.name}</span>
                      <span className="block truncate text-xs text-zinc-500">{i.candidate.email}</span>
                    </span>
                  </span>
                </td>
                <td className="px-3 py-3">
                  <span className="flex items-center gap-2">
                    <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: i.eventType.color }} />
                    <span className="truncate text-zinc-700">{i.eventType.name}</span>
                  </span>
                </td>
                {showInterviewer && <td className="whitespace-nowrap px-3 py-3 text-zinc-600">{i.host.name}</td>}
                <td className="px-3 py-3">
                  <span className="flex items-center gap-1.5">
                    <InterviewStatusBadge status={i.status} />
                    {i.rescheduleCount > 0 && i.status !== 'rescheduled' && <span className="text-xs text-violet-600" title="Rescheduled">↻</span>}
                  </span>
                </td>
                <td className="py-3 pl-3 pr-5">
                  <span className="flex items-center gap-1.5">
                    {i.locationType === 'zoom' ? (
                      <span className="inline-flex items-center gap-1" title="Zoom meeting">
                        <Video className="size-3.5 text-zinc-400" />
                        <SyncBadge status={i.meetingStatus} />
                      </span>
                    ) : null}
                    <span className="inline-flex items-center gap-1" title="Calendar event">
                      <CalendarDays className="size-3.5 text-zinc-400" />
                      <SyncBadge status={i.calendarStatus} />
                    </span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
