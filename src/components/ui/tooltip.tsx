'use client';

import { Tooltip as T } from 'radix-ui';

export function Tooltip({ content, children, side = 'top' }: { content: React.ReactNode; children: React.ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <T.Provider delayDuration={250}>
      <T.Root>
        <T.Trigger asChild>{children}</T.Trigger>
        <T.Portal>
          <T.Content side={side} sideOffset={6} className="z-50 max-w-xs rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs text-white shadow-pop data-[state=delayed-open]:animate-fade-in">
            {content}
            <T.Arrow className="fill-zinc-900" />
          </T.Content>
        </T.Portal>
      </T.Root>
    </T.Provider>
  );
}
