'use client';

import { Popover } from 'radix-ui';
import { Check, ChevronDown, Globe2, Search } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { allTimeZones, zoneLabel, zoneOffsetLabel } from '@/lib/time';

/** Searchable IANA time-zone picker showing the current UTC offset of each zone. */
export function TimezoneSelect({
  value,
  onChange,
  id,
  className,
  variant = 'input',
}: {
  value: string;
  onChange: (zone: string) => void;
  id?: string;
  className?: string;
  variant?: 'input' | 'inline';
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const zones = useMemo(() => {
    const now = new Date();
    return allTimeZones().map((z) => ({ zone: z, label: zoneLabel(z), offset: zoneOffsetLabel(z, now) }));
  }, []);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return zones;
    return zones.filter((z) => z.zone.toLowerCase().includes(q) || z.label.toLowerCase().includes(q) || z.offset.toLowerCase().includes(q));
  }, [zones, query]);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery('');
      }}
    >
      <Popover.Trigger asChild>
        <button
          id={id}
          type="button"
          className={cn(
            variant === 'input'
              ? 'flex h-9 w-full items-center gap-2 rounded-lg border border-zinc-300 bg-white px-3 text-left text-sm text-zinc-900 shadow-xs hover:border-zinc-400 focus:border-brand-500 focus:outline-none focus:ring-3 focus:ring-brand-500/15'
              : 'inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm font-medium text-zinc-700 hover:bg-zinc-100',
            className,
          )}
          aria-label={`Time zone: ${value}`}
        >
          <Globe2 className="size-4 shrink-0 text-zinc-400" />
          <span className="min-w-0 flex-1 truncate">{zoneLabel(value)}</span>
          <span className="shrink-0 text-xs text-zinc-400">{zoneOffsetLabel(value)}</span>
          <ChevronDown className="size-4 shrink-0 text-zinc-400" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-zinc-200 bg-white p-1.5 shadow-pop data-[state=open]:animate-fade-in"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).querySelector('input')?.focus();
          }}
        >
          <div className="relative mb-1.5">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search city or region…"
              className="h-9 w-full rounded-lg border border-zinc-200 bg-zinc-50 pl-8 pr-3 text-sm focus:border-brand-500 focus:bg-white focus:outline-none"
              aria-label="Search time zones"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && filtered[0]) {
                  onChange(filtered[0].zone);
                  setOpen(false);
                }
                if (e.key === 'ArrowDown') listRef.current?.querySelector('button')?.focus();
              }}
            />
          </div>
          <div ref={listRef} className="scrollbar-thin max-h-72 overflow-y-auto" role="listbox" aria-label="Time zones">
            {filtered.length === 0 && <p className="px-3 py-6 text-center text-sm text-zinc-500">No matching time zones</p>}
            {filtered.slice(0, 300).map((z) => (
              <button
                key={z.zone}
                type="button"
                role="option"
                aria-selected={z.zone === value}
                onClick={() => {
                  onChange(z.zone);
                  setOpen(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') (e.currentTarget.nextElementSibling as HTMLElement | null)?.focus();
                  if (e.key === 'ArrowUp') (e.currentTarget.previousElementSibling as HTMLElement | null)?.focus();
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-zinc-100 focus:bg-zinc-100 focus:outline-none',
                  z.zone === value && 'font-medium text-brand-800',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{z.label}</span>
                <span className="shrink-0 text-xs text-zinc-400">{z.offset}</span>
                {z.zone === value && <Check className="size-4 shrink-0 text-brand-600" />}
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
