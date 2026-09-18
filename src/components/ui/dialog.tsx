'use client';

import { Dialog as D } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({
  title,
  description,
  children,
  className,
  size = 'md',
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const widths = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-zinc-950/40 backdrop-blur-[2px] data-[state=open]:animate-fade-in" />
      <D.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-white shadow-pop focus:outline-none data-[state=open]:animate-scale-in',
          widths[size],
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-zinc-100 px-6 py-4">
          <div>
            <D.Title className="text-base font-semibold text-zinc-900">{title}</D.Title>
            {description ? (
              <D.Description className="mt-1 text-sm text-zinc-500">{description}</D.Description>
            ) : (
              <D.Description className="sr-only">{typeof title === 'string' ? title : 'Dialog'}</D.Description>
            )}
          </div>
          <D.Close className="-mr-2 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600" aria-label="Close">
            <X className="size-4" />
          </D.Close>
        </div>
        <div className="px-6 py-5">{children}</div>
      </D.Content>
    </D.Portal>
  );
}

export function DialogFooter({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('-mx-6 -mb-5 mt-6 flex items-center justify-end gap-2 border-t border-zinc-100 bg-zinc-50/60 px-6 py-3.5', className)}>{children}</div>;
}
