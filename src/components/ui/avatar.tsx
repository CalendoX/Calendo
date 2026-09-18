import { cn } from '@/lib/cn';
import { initials } from '@/lib/format';

const palette = ['bg-brand-100 text-brand-800', 'bg-sky-100 text-sky-800', 'bg-violet-100 text-violet-800', 'bg-amber-100 text-amber-800', 'bg-rose-100 text-rose-800', 'bg-teal-100 text-teal-800', 'bg-indigo-100 text-indigo-800'];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function Avatar({ name, size = 'md', className }: { name: string; size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'; className?: string }) {
  const sizes = { xs: 'size-5 text-[9px]', sm: 'size-7 text-[11px]', md: 'size-9 text-xs', lg: 'size-12 text-sm', xl: 'size-16 text-lg' };
  return (
    <span className={cn('inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold', palette[hash(name) % palette.length], sizes[size], className)} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
