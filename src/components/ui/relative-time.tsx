import { DateTime } from 'luxon';

/**
 * "5 minutes ago". The server and the browser render this at different moments, so the text can
 * legitimately differ during hydration (e.g. "1 second ago" vs "2 seconds ago"); keep the
 * server's text rather than failing hydration.
 */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  return (
    <time dateTime={iso} className={className} suppressHydrationWarning>
      {DateTime.fromISO(iso).toRelative()}
    </time>
  );
}
