import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';

export function Pagination({ page, pageSize, total, hrefFor }: { page: number; pageSize: number; total: number; hrefFor: (page: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const btn = 'inline-flex h-8 items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2.5 text-sm text-zinc-700 hover:bg-zinc-50';
  return (
    <div className="flex items-center justify-between gap-4 px-1 py-3 text-sm text-zinc-500">
      <span className="tabular">
        {from}–{to} of {total}
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link className={btn} href={hrefFor(page - 1)}>
            <ChevronLeft className="size-4" /> Previous
          </Link>
        ) : (
          <span className={cn(btn, 'pointer-events-none opacity-40')}>
            <ChevronLeft className="size-4" /> Previous
          </span>
        )}
        {page < pages ? (
          <Link className={btn} href={hrefFor(page + 1)}>
            Next <ChevronRight className="size-4" />
          </Link>
        ) : (
          <span className={cn(btn, 'pointer-events-none opacity-40')}>
            Next <ChevronRight className="size-4" />
          </span>
        )}
      </div>
    </div>
  );
}
