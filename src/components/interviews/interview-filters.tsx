'use client';

import { Search, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

/** URL-synchronised search/filter bar for interview lists. */
export function InterviewFilters({
  interviewers,
  eventTypes,
  showInterviewer,
}: {
  interviewers: { id: string; name: string }[];
  eventTypes: { id: string; name: string; hostName: string }[];
  showInterviewer: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState(params.get('q') ?? '');

  function update(patch: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    next.delete('page');
    startTransition(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
  }

  useEffect(() => {
    const current = params.get('q') ?? '';
    if (q === current) return;
    const t = setTimeout(() => update({ q: q.trim() || null }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const hasFilters = ['q', 'interviewerId', 'eventTypeId', 'status', 'from', 'to', 'sort'].some((k) => params.get(k));

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-4 py-3">
      <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search candidate, email, interviewer…" className="pl-9" aria-label="Search interviews" />
      </div>
      {showInterviewer && (
        <Select aria-label="Interviewer" className="w-auto min-w-[150px]" value={params.get('interviewerId') ?? ''} onChange={(e) => update({ interviewerId: e.target.value || null })}>
          <option value="">All interviewers</option>
          {interviewers.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </Select>
      )}
      <Select aria-label="Interview type" className="w-auto min-w-[150px]" value={params.get('eventTypeId') ?? ''} onChange={(e) => update({ eventTypeId: e.target.value || null })}>
        <option value="">All interview types</option>
        {eventTypes.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
            {showInterviewer ? ` — ${e.hostName}` : ''}
          </option>
        ))}
      </Select>
      <Select aria-label="Status" className="w-auto" value={params.get('status') ?? ''} onChange={(e) => update({ status: e.target.value || null })}>
        <option value="">Any status</option>
        <option value="scheduled">Scheduled</option>
        <option value="rescheduled">Rescheduled</option>
        <option value="completed">Completed</option>
        <option value="no_show">No-show</option>
        <option value="cancelled">Cancelled</option>
      </Select>
      <div className="flex items-center gap-1.5">
        <Input type="date" aria-label="From date" className="w-[140px]" value={params.get('from') ?? ''} onChange={(e) => update({ from: e.target.value || null })} />
        <span className="text-zinc-400">–</span>
        <Input type="date" aria-label="To date" className="w-[140px]" value={params.get('to') ?? ''} onChange={(e) => update({ to: e.target.value || null })} />
      </div>
      <Select aria-label="Sort" className="w-auto" value={params.get('sort') ?? ''} onChange={(e) => update({ sort: e.target.value || null })}>
        <option value="">Default order</option>
        <option value="start_asc">Soonest first</option>
        <option value="start_desc">Latest first</option>
        <option value="created_desc">Recently booked</option>
      </Select>
      {pending && <Spinner className="text-zinc-400" />}
      {hasFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setQ('');
            update({ q: null, interviewerId: null, eventTypeId: null, status: null, from: null, to: null, sort: null });
          }}
        >
          <X /> Clear
        </Button>
      )}
    </div>
  );
}
