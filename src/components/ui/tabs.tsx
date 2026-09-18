import Link from 'next/link';
import { cn } from '@/lib/cn';

/** URL-driven tab bar (server-renderable). */
export function LinkTabs({ tabs, active, className }: { tabs: { key: string; label: React.ReactNode; href: string; count?: number }[]; active: string; className?: string }) {
  return (
    <nav className={cn('-mb-px flex gap-1 overflow-x-auto border-b border-zinc-200', className)} aria-label="Tabs">
      {tabs.map((t) => {
        const isActive = t.key === active;
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-3 pb-2.5 pt-1 text-sm font-medium transition-colors',
              isActive ? 'border-brand-600 text-zinc-900' : 'border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-700',
            )}
          >
            {t.label}
            {t.count !== undefined && (
              <span className={cn('tabular rounded-full px-1.5 py-px text-[11px]', isActive ? 'bg-brand-50 text-brand-700' : 'bg-zinc-100 text-zinc-500')}>{t.count}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

export function Segmented<T extends string>({ value, options, onChange, className }: { value: T; options: { value: T; label: React.ReactNode }[]; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cn('inline-flex rounded-lg bg-zinc-100 p-0.5', className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-md px-3 py-1 text-sm font-medium transition',
            o.value === value ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
