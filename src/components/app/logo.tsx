import { cn } from '@/lib/cn';
import logo from './calendo-logo.png';

/** The app icon (calendo_logo.png, trimmed to 128px). Decorative: the name always sits beside it. */
export function LogoMark({ className }: { className?: string }) {
  return <img src={logo.src} width={logo.width} height={logo.height} alt="" draggable={false} className={cn('size-7 select-none', className)} />;
}

export function Logo({ className, tone = 'dark' }: { className?: string; tone?: 'dark' | 'light' }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark />
      <span className={cn('text-[17px] font-semibold tracking-tight', tone === 'light' ? 'text-white' : 'text-zinc-900')}>Calendo</span>
    </span>
  );
}
