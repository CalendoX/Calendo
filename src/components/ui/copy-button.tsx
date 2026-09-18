'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, type ButtonProps } from './button';

export function CopyButton({ value, label = 'Copy link', copiedLabel = 'Copied', variant = 'secondary', size = 'sm', iconOnly, ...rest }: { value: string; label?: string; copiedLabel?: string; iconOnly?: boolean } & Omit<ButtonProps, 'onClick'>) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant={variant}
      size={iconOnly ? 'icon-sm' : size}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          toast.success('Copied to clipboard');
          setTimeout(() => setCopied(false), 1600);
        } catch {
          toast.error('Could not copy — select and copy manually.');
        }
      }}
      {...rest}
    >
      {copied ? <Check /> : <Copy />}
      {!iconOnly && (copied ? copiedLabel : label)}
    </Button>
  );
}
