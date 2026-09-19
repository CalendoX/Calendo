'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, type ButtonProps } from './button';

export function CopyButton({
  value,
  label = 'Copy link',
  copiedLabel = 'Copied',
  copiedMessage = 'Copied to clipboard',
  onCopied,
  variant = 'secondary',
  size = 'sm',
  iconOnly,
  ...rest
}: {
  /** The text to copy, or a function computing it at click time (e.g. from `window.location`). */
  value: string | (() => string);
  label?: string;
  copiedLabel?: string;
  copiedMessage?: string;
  onCopied?: () => void;
  iconOnly?: boolean;
} & Omit<ButtonProps, 'onClick' | 'value'>) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant={variant}
      size={iconOnly ? (size === 'md' ? 'icon' : 'icon-sm') : size}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(typeof value === 'function' ? value() : value);
          setCopied(true);
          onCopied?.();
          toast.success(copiedMessage);
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
