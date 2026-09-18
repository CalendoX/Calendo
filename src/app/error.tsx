'use client';

import { Button } from '@/components/ui/button';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">
      <p className="text-sm font-semibold text-rose-600">Something went wrong</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-900">We couldn’t load this page</h1>
      <p className="mt-2 max-w-sm text-sm text-zinc-500">Please try again. If the problem continues, contact your administrator{error.digest ? ` and mention reference ${error.digest}` : ''}.</p>
      <Button className="mt-6" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
