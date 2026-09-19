import Link from 'next/link';
import { LogoMark } from '@/components/app/logo';
import { cn } from '@/lib/cn';

/** Chrome for candidate-facing pages: organisation branding + "Powered by Calendor". */
export function PublicFrame({ children, width = 'wide' }: { children: React.ReactNode; width?: 'wide' | 'narrow' }) {
  return (
    <div className="flex min-h-screen flex-col items-center bg-[#f3f4f1] px-3 py-6 sm:px-6 sm:py-12">
      <div className={cn('w-full', width === 'wide' ? 'max-w-[1060px]' : 'max-w-[640px]')}>{children}</div>
      <Link href="/" className="mt-8 inline-flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-600">
        <LogoMark className="size-4" /> Powered by Calendor
      </Link>
    </div>
  );
}

export function OrgBrand({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  if (logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logoUrl} alt={name} className="h-8 max-w-[180px] object-contain object-left" />;
  }
  return <p className="text-sm font-semibold tracking-tight text-zinc-900">{name}</p>;
}

export function PublicMessage({ title, children, tone = 'neutral' }: { title: string; children?: React.ReactNode; tone?: 'neutral' | 'error' }) {
  return (
    <PublicFrame width="narrow">
      <div className="rounded-2xl border border-zinc-200 bg-white px-8 py-12 text-center shadow-card">
        <div className={cn('mx-auto mb-5 flex size-12 items-center justify-center rounded-full', tone === 'error' ? 'bg-rose-50 text-rose-600' : 'bg-zinc-100 text-zinc-500')}>
          <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v5M12 16h.01" strokeLinecap="round" />
          </svg>
        </div>
        <h1 className="text-xl font-semibold text-zinc-900">{title}</h1>
        {children && <div className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-zinc-500">{children}</div>}
      </div>
    </PublicFrame>
  );
}
