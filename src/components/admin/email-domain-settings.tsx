'use client';

import { CheckCircle2, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RelativeTime } from '@/components/ui/relative-time';
import { api, ApiError, errorMessage } from '@/lib/api-client';

export interface EmailDomainViewDto {
  available: boolean;
  platformFrom: string;
  domain: {
    domain: string;
    status: string;
    verified: boolean;
    records: { type: string; name: string; value: string; priority: number | null; status: string | null }[];
    fromName: string;
    fromLocalPart: string;
    fromAddress: string;
    verifiedAt: string | null;
    lastCheckedAt: string | null;
  } | null;
}

const STATUS: Record<string, { label: string; tone: 'green' | 'amber' | 'red' }> = {
  verified: { label: 'Verified', tone: 'green' },
  failed: { label: 'Verification failed', tone: 'red' },
};

function statusBadge(status: string) {
  const s = STATUS[status] ?? { label: 'Waiting for DNS', tone: 'amber' as const };
  return (
    <Badge tone={s.tone} dot>
      {s.label}
    </Badge>
  );
}

/** Lets each business send its interview emails from its own domain instead of the platform address. */
export function EmailDomainSettings({ initial, organizationName }: { initial: EmailDomainViewDto; organizationName: string }) {
  const [view, setView] = useState(initial);
  if (!view.available) {
    return (
      <Card>
        <CardHeader title="Send from your own domain" />
        <CardBody>
          <Alert tone="warning" title="Not available on this server yet">
            Emails currently go out from <span className="font-medium">{view.platformFrom}</span> with your organization’s name, and replies reach your interviewers.
            To send from your own domain, the platform operator needs to set <code>EMAIL_PROVIDER=resend</code> and a full-access <code>RESEND_API_KEY</code>.
          </Alert>
        </CardBody>
      </Card>
    );
  }
  return view.domain ? <ConnectedDomain view={view} onChange={setView} /> : <AddDomain view={view} organizationName={organizationName} onChange={setView} />;
}

function AddDomain({ view, organizationName, onChange }: { view: EmailDomainViewDto; organizationName: string; onChange: (v: EmailDomainViewDto) => void }) {
  const [v, setV] = useState({ domain: '', fromName: organizationName, fromLocalPart: 'scheduling' });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  return (
    <Card>
      <CardHeader
        title="Send from your own domain"
        description={`Interview emails to candidates and interviewers come from your domain instead of ${view.platformFrom}.`}
      />
      <CardBody>
        <form
          className="grid gap-5 md:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErrors({});
            try {
              onChange(await api<EmailDomainViewDto>('/api/admin/email-domain', { body: v }));
              toast.success('Domain added — now add its DNS records');
            } catch (err) {
              if (err instanceof ApiError) setErrors(err.fieldErrors);
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Your domain" htmlFor="ed-domain" error={errors.domain} hint="A domain you own and can edit DNS for, e.g. acme.com." className="md:col-span-2">
            <Input id="ed-domain" value={v.domain} onChange={(e) => setV({ ...v, domain: e.target.value })} placeholder="acme.com" required autoComplete="off" />
          </Field>
          <Field label="Sender name" htmlFor="ed-name" error={errors.fromName}>
            <Input id="ed-name" value={v.fromName} onChange={(e) => setV({ ...v, fromName: e.target.value })} required maxLength={80} />
          </Field>
          <Field label="Sender address" htmlFor="ed-local" error={errors.fromLocalPart}>
            <div className="flex items-center gap-2">
              <Input id="ed-local" value={v.fromLocalPart} onChange={(e) => setV({ ...v, fromLocalPart: e.target.value })} required className="min-w-0" />
              <span className="shrink-0 text-sm text-zinc-500">@{v.domain.trim() || 'acme.com'}</span>
            </div>
          </Field>
          <div className="flex justify-end md:col-span-2">
            <Button type="submit" loading={busy}>
              Add domain
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function ConnectedDomain({ view, onChange }: { view: EmailDomainViewDto; onChange: (v: EmailDomainViewDto) => void }) {
  const router = useRouter();
  const d = view.domain!;
  const [sender, setSender] = useState({ fromName: d.fromName, fromLocalPart: d.fromLocalPart });
  const [busy, setBusy] = useState<'verify' | 'sender' | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmRemove, setConfirmRemove] = useState(false);
  const senderDirty = sender.fromName !== d.fromName || sender.fromLocalPart !== d.fromLocalPart;

  async function verify() {
    setBusy('verify');
    try {
      const next = await api<EmailDomainViewDto>('/api/admin/email-domain/verify', { method: 'POST', body: {} });
      onChange(next);
      if (next.domain?.verified) toast.success(`${d.domain} is verified — emails now come from your domain`);
      else toast.info('Not verified yet. DNS changes can take a while to spread; try again in a few minutes.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title={d.domain} description="Your email sending domain" action={statusBadge(d.status)} />
        <CardBody className="space-y-4">
          {d.verified ? (
            <Alert tone="success" title="Emails come from your domain">
              Interview emails are sent from <span className="font-medium">{`${d.fromName} <${d.fromAddress}>`}</span>. Keep the DNS records below in place.
            </Alert>
          ) : (
            <p className="text-sm text-zinc-600">
              Add these records at your domain’s DNS provider (e.g. Cloudflare, GoDaddy, Namecheap), then click <span className="font-medium">Verify</span>. DNS changes can
              take from a few minutes to a few hours. Until then, emails come from <span className="font-medium">{view.platformFrom}</span>.
            </p>
          )}
          <div className="overflow-x-auto rounded-lg ring-1 ring-zinc-200">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-zinc-100 bg-zinc-50 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Value</th>
                  <th className="px-3 py-2 font-medium">Priority</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {d.records.map((r) => (
                  <tr key={`${r.type}-${r.name}-${r.value}`}>
                    <td className="px-3 py-2 font-mono text-xs">{r.type}</td>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-1.5">
                        <code className="truncate text-xs">{r.name}</code>
                        <CopyButton value={r.name} iconOnly variant="ghost" label={`Copy name ${r.name}`} />
                      </span>
                    </td>
                    <td className="max-w-[280px] px-3 py-2">
                      <span className="flex items-center gap-1.5">
                        <code className="min-w-0 truncate text-xs" title={r.value}>
                          {r.value}
                        </code>
                        <CopyButton value={r.value} iconOnly variant="ghost" label="Copy value" />
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-500">{r.priority ?? '—'}</td>
                    <td className="px-3 py-2">
                      {r.status === 'verified' ? (
                        <CheckCircle2 className="size-4 text-emerald-600" aria-label="Verified" />
                      ) : (
                        <span className="text-xs text-zinc-500">{r.status === 'failed' ? 'Not found' : 'Pending'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-zinc-500">
            Names are relative to {d.domain}; if your DNS provider asks for the full name, add “.{d.domain}”. For Cloudflare, set these records to “DNS only”.
            {d.lastCheckedAt && (
              <>
                {' '}
                Last checked <RelativeTime iso={d.lastCheckedAt} />.
              </>
            )}
          </p>
          <div className="flex flex-wrap justify-between gap-2">
            <Button variant="danger-outline" onClick={() => setConfirmRemove(true)}>
              Remove domain
            </Button>
            {!d.verified && (
              <Button onClick={verify} loading={busy === 'verify'}>
                {busy !== 'verify' && <RefreshCw />} Verify DNS records
              </Button>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Sender" description="How your emails appear in inboxes. Replies go to the interviewer (or the candidate, for interviewer emails)." />
        <CardBody>
          <form
            className="grid gap-5 md:grid-cols-2"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy('sender');
              setErrors({});
              try {
                onChange(await api<EmailDomainViewDto>('/api/admin/email-domain', { method: 'PATCH', body: sender }));
                toast.success('Sender saved');
              } catch (err) {
                if (err instanceof ApiError) setErrors(err.fieldErrors);
                toast.error(errorMessage(err));
              } finally {
                setBusy(null);
              }
            }}
          >
            <Field label="Sender name" htmlFor="ed-sender-name" error={errors.fromName}>
              <Input id="ed-sender-name" value={sender.fromName} onChange={(e) => setSender({ ...sender, fromName: e.target.value })} required maxLength={80} />
            </Field>
            <Field label="Sender address" htmlFor="ed-sender-local" error={errors.fromLocalPart}>
              <div className="flex items-center gap-2">
                <Input id="ed-sender-local" value={sender.fromLocalPart} onChange={(e) => setSender({ ...sender, fromLocalPart: e.target.value })} required className="min-w-0" />
                <span className="shrink-0 text-sm text-zinc-500">@{d.domain}</span>
              </div>
            </Field>
            <div className="flex justify-end md:col-span-2">
              <Button type="submit" loading={busy === 'sender'} disabled={!senderDirty}>
                Save sender
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove ${d.domain}?`}
        description={`Emails will go back to coming from ${view.platformFrom}. You can add the domain again later, but you'll need to verify it again.`}
        confirmLabel="Remove domain"
        onConfirm={async () => {
          try {
            await api('/api/admin/email-domain', { method: 'DELETE' });
            onChange({ ...view, domain: null });
            setConfirmRemove(false);
            toast.success('Domain removed');
            router.refresh();
          } catch (err) {
            toast.error(errorMessage(err));
          }
        }}
      />
    </div>
  );
}
