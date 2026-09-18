import Link from 'next/link';
import { cn } from '@/lib/cn';

export function StatCard({ label, value, hint, icon, href, tone = 'neutral' }: { label: string; value: React.ReactNode; hint?: React.ReactNode; icon?: React.ReactNode; href?: string; tone?: 'neutral' | 'brand' | 'warning' | 'danger' }) {
  const iconTone = { neutral: 'bg-zinc-100 text-zinc-600', brand: 'bg-brand-50 text-brand-700', warning: 'bg-amber-50 text-amber-700', danger: 'bg-rose-50 text-rose-700' }[tone];
  const body = (
    <div className={cn('group h-full rounded-xl border border-zinc-200/80 bg-white p-4 shadow-card transition', href && 'hover:border-zinc-300 hover:shadow-sm')}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-zinc-500">{label}</p>
        {icon && <span className={cn('flex size-8 items-center justify-center rounded-lg [&_svg]:size-4', iconTone)}>{icon}</span>}
      </div>
      <p className="tabular mt-2 text-[28px] font-semibold leading-none tracking-tight text-zinc-900">{value}</p>
      {hint && <p className="mt-2 text-xs text-zinc-500">{hint}</p>}
    </div>
  );
  return href ? (
    <Link href={href} className="block h-full rounded-xl focus-visible:outline-2">
      {body}
    </Link>
  ) : (
    body
  );
}
