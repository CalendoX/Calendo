'use client';

import { AlertTriangle, CheckCircle2, RefreshCw, Unplug } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, type ButtonProps } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { Select } from '@/components/ui/input';
import { RelativeTime } from '@/components/ui/relative-time';
import { Switch } from '@/components/ui/switch';
import { api, errorMessage } from '@/lib/api-client';

export interface IntegrationSummaryDto {
  provider: 'google_calendar' | 'zoom';
  configured: boolean;
  connected: boolean;
  status: 'active' | 'error' | 'disconnected' | null;
  accountEmail: string | null;
  connectedAt: string | null;
  lastError: string | null;
  calendars: { id: string; externalCalendarId: string; name: string; isPrimary: boolean; accessRole: string | null; checkConflicts: boolean; isWriteTarget: boolean; color: string | null }[];
}

const META = {
  google_calendar: {
    name: 'Google Calendar',
    slug: 'google',
    blurb: 'Check your calendars for conflicts so candidates only see free times, and add every interview to your calendar automatically.',
    logo: (
      <svg viewBox="0 0 48 48" className="size-10" aria-hidden="true">
        <rect x="6" y="6" width="36" height="36" rx="6" fill="#fff" stroke="#e4e4e7" />
        <path d="M6 16h36" stroke="#4285F4" strokeWidth="4" />
        <text x="24" y="37" textAnchor="middle" fontSize="16" fontWeight="700" fill="#4285F4" fontFamily="Arial, sans-serif">31</text>
      </svg>
    ),
  },
  zoom: {
    name: 'Zoom',
    slug: 'zoom',
    blurb: 'Create a unique Zoom meeting for every interview. Meetings are updated when interviews move and removed when they’re cancelled.',
    logo: (
      <svg viewBox="0 0 48 48" className="size-10" aria-hidden="true">
        <rect width="48" height="48" rx="11" fill="#0B5CFF" />
        <path d="M11 18a3 3 0 0 1 3-3h13a4 4 0 0 1 4 4v11a3 3 0 0 1-3 3H15a4 4 0 0 1-4-4V18Z" fill="#fff" />
        <path d="m33 21 5-3.5c.7-.5 1.6 0 1.6.8v11.4c0 .8-.9 1.3-1.6.8L33 27v-6Z" fill="#fff" />
      </svg>
    ),
  },
} as const;

/**
 * Connects Google / Zoom via the shareable /integrations/connect/[provider] link: opens it in a new
 * tab, or copies it to authorise from another browser. Refreshes this page whenever the user comes
 * back to it, so a connection made elsewhere shows up here too.
 */
export function ConnectButton({
  provider,
  configured,
  children,
  size = 'md',
}: {
  provider: IntegrationSummaryDto['provider'];
  configured: boolean;
  children?: React.ReactNode;
  size?: ButtonProps['size'];
}) {
  const router = useRouter();
  const meta = META[provider];
  const path = `/integrations/connect/${meta.slug}`;
  const [awaitingReturn, setAwaitingReturn] = useState(false);

  useEffect(() => {
    if (!awaitingReturn) return;
    const refresh = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    const stop = setTimeout(() => setAwaitingReturn(false), 15 * 60_000);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
      clearTimeout(stop);
    };
  }, [awaitingReturn, router]);

  const label = children ?? `Connect ${meta.name}`;
  if (!configured) {
    return (
      <Button size={size} disabled>
        {label}
      </Button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <Button asChild size={size}>
        <a href={path} target="_blank" rel="noopener" onClick={() => setAwaitingReturn(true)}>
          {label}
        </a>
      </Button>
      <CopyButton
        iconOnly
        size={size}
        value={() => new URL(path, window.location.origin).href}
        label={`Copy link to connect ${meta.name} from another browser`}
        title="Copy link to connect from another browser"
        copiedMessage="Link copied. Open it in any browser — you’ll sign in to Calendo there first if needed."
        onCopied={() => setAwaitingReturn(true)}
      />
    </span>
  );
}

export function IntegrationCard({ integration, pushNotifications }: { integration: IntegrationSummaryDto; pushNotifications: boolean }) {
  const router = useRouter();
  const meta = META[integration.provider];
  const [confirm, setConfirm] = useState(false);
  const [calendars, setCalendars] = useState(integration.calendars);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const writeTarget = calendars.find((c) => c.isWriteTarget)?.id ?? '';
  const dirty = JSON.stringify(calendars) !== JSON.stringify(integration.calendars);

  const error = integration.status === 'error';

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-5 p-6 sm:flex-row sm:items-start">
        <div className="shrink-0">{meta.logo}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-zinc-900">{meta.name}</h2>
            {integration.connected ? (
              error ? (
                <Badge tone="red" dot>
                  Reconnect required
                </Badge>
              ) : (
                <Badge tone="green" dot>
                  Connected
                </Badge>
              )
            ) : (
              <Badge>Not connected</Badge>
            )}
          </div>
          <p className="mt-1 max-w-xl text-sm leading-relaxed text-zinc-500">{meta.blurb}</p>
          {integration.connected && (
            <p className="mt-2 text-sm text-zinc-600">
              <span className="font-medium text-zinc-800">{integration.accountEmail ?? 'Connected account'}</span>
              {integration.connectedAt && (
                <span className="text-zinc-400">
                  {' '}
                  · connected <RelativeTime iso={integration.connectedAt} />
                </span>
              )}
            </p>
          )}
          {!integration.configured && (
            <Alert tone="warning" className="mt-4" title="Not configured on this server">
              An administrator needs to add the {meta.name} OAuth client credentials ({integration.provider === 'zoom' ? 'ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET' : 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET'}) to the environment.
            </Alert>
          )}
          {error && integration.lastError && (
            <Alert tone="error" className="mt-4" title="Calendo lost access to this account">
              {integration.lastError}
              {integration.provider === 'google_calendar' && ' Booking pages are paused until you reconnect, so candidates can’t double-book you.'}
            </Alert>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {integration.connected ? (
            <>
              {error && (
                <ConnectButton provider={integration.provider} configured={integration.configured}>
                  Reconnect
                </ConnectButton>
              )}
              <Button variant="secondary" onClick={() => setConfirm(true)}>
                <Unplug /> Disconnect
              </Button>
            </>
          ) : (
            <ConnectButton provider={integration.provider} configured={integration.configured} />
          )}
        </div>
      </div>

      {integration.provider === 'google_calendar' && integration.connected && !error && (
        <div className="border-t border-zinc-100 bg-zinc-50/50 px-6 py-5">
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-zinc-900">Check for conflicts</p>
                <Button
                  variant="ghost"
                  size="xs"
                  loading={refreshing}
                  onClick={async () => {
                    setRefreshing(true);
                    try {
                      await api('/api/integrations/google/calendars', { method: 'POST', body: {} });
                      router.refresh();
                    } catch (err) {
                      toast.error(errorMessage(err));
                    } finally {
                      setRefreshing(false);
                    }
                  }}
                >
                  {!refreshing && <RefreshCw />} Refresh list
                </Button>
              </div>
              <p className="mb-3 text-xs text-zinc-500">Busy time on these calendars is removed from your availability.</p>
              <ul className="space-y-1.5">
                {calendars.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 rounded-lg bg-white px-3 py-2 ring-1 ring-zinc-200">
                    <span className="flex min-w-0 items-center gap-2 text-sm text-zinc-800">
                      <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.color ?? '#a1a1aa' }} />
                      <span className="truncate">{c.name}</span>
                      {c.isPrimary && <Badge tone="neutral">Primary</Badge>}
                    </span>
                    <Switch
                      checked={c.checkConflicts}
                      onCheckedChange={(on) => setCalendars(calendars.map((x) => (x.id === c.id ? { ...x, checkConflicts: on } : x)))}
                      aria-label={`Check ${c.name} for conflicts`}
                    />
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-2 text-sm font-semibold text-zinc-900">Add interviews to</p>
              <p className="mb-3 text-xs text-zinc-500">New interviews are created on this calendar, with the Zoom link and candidate details.</p>
              <Select
                aria-label="Calendar for new interviews"
                value={writeTarget}
                onChange={(e) => setCalendars(calendars.map((x) => ({ ...x, isWriteTarget: x.id === e.target.value })))}
              >
                <option value="">Don’t add interviews to a calendar</option>
                {calendars
                  .filter((c) => c.accessRole === 'owner' || c.accessRole === 'writer')
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </Select>
              <div className="mt-4 flex items-start gap-2 text-xs text-zinc-500">
                {pushNotifications ? (
                  <>
                    <CheckCircle2 className="mt-px size-3.5 shrink-0 text-emerald-600" /> Real-time change notifications are active.
                  </>
                ) : (
                  <>
                    <AlertTriangle className="mt-px size-3.5 shrink-0 text-amber-500" /> Real-time change notifications need a public HTTPS URL (WEBHOOK_BASE_URL). Conflicts are still checked live on every booking.
                  </>
                )}
              </div>
              {dirty && (
                <div className="mt-4 flex gap-2">
                  <Button
                    size="sm"
                    loading={saving}
                    onClick={async () => {
                      setSaving(true);
                      try {
                        await api('/api/integrations/google/calendars', {
                          method: 'PATCH',
                          body: { writeCalendarId: calendars.find((c) => c.isWriteTarget)?.id ?? null, conflictCalendarIds: calendars.filter((c) => c.checkConflicts).map((c) => c.id) },
                        });
                        toast.success('Calendar settings saved');
                        router.refresh();
                      } catch (err) {
                        toast.error(errorMessage(err));
                      } finally {
                        setSaving(false);
                      }
                    }}
                  >
                    Save calendar settings
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setCalendars(integration.calendars)}>
                    Discard
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Disconnect ${meta.name}?`}
        description={
          integration.provider === 'zoom'
            ? 'New interviews won’t get Zoom links. Existing meetings stay in Zoom but will no longer be updated when interviews change.'
            : 'Your availability will no longer account for calendar conflicts and new interviews won’t be added to your calendar. Existing events stay in place.'
        }
        confirmLabel="Disconnect"
        onConfirm={async () => {
          try {
            await api(`/api/integrations/${meta.slug}/disconnect`, { body: {} });
            toast.success(`${meta.name} disconnected`);
            setConfirm(false);
            router.refresh();
          } catch (err) {
            toast.error(errorMessage(err));
          }
        }}
      />
    </Card>
  );
}
