'use client';

import { DateTime } from 'luxon';
import { Link2, Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError, errorMessage } from '@/lib/api-client';

interface LinkRow {
  id: string;
  label: string | null;
  candidateName: string | null;
  candidateEmail: string | null;
  maxUses: number | null;
  useCount: number;
  expiresAt: string | null;
  createdAt: string;
  createdBy: string | null;
  status: 'active' | 'expired' | 'used' | 'revoked';
  url: string | null;
}

/** Personal (single-use / expiring) scheduling links for an event type. */
export function SchedulingLinksPanel({ eventTypeId, timezone }: { eventTypeId: string; timezone: string }) {
  const [links, setLinks] = useState<LinkRow[] | null>(null);
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await api<{ items: LinkRow[] }>(`/api/event-types/${eventTypeId}/links`);
      setLinks(res.items);
    } catch (err) {
      toast.error(errorMessage(err));
      setLinks([]);
    }
  }, [eventTypeId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Card id="links">
      <CardHeader
        title="Single-use scheduling links"
        description="Send a personal link to one candidate. It can expire and stops working once used."
        action={
          <Button size="sm" onClick={() => { setCreated(null); setOpen(true); }}>
            <Plus /> New link
          </Button>
        }
      />
      {links === null ? (
        <div className="space-y-2 p-5">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : links.length === 0 ? (
        <EmptyState icon={<Link2 />} title="No personal links yet" description="Personal links are ideal for private interview types and for pre-filling a candidate’s name and email." />
      ) : (
        <ul className="divide-y divide-zinc-100">
          {links.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-zinc-900">{l.label || l.candidateName || l.candidateEmail || 'Personal link'}</p>
                <p className="text-xs text-zinc-500">
                  {l.candidateEmail && `${l.candidateEmail} · `}
                  {l.maxUses ? `${l.useCount}/${l.maxUses} used` : `${l.useCount} bookings`}
                  {l.expiresAt && ` · expires ${DateTime.fromISO(l.expiresAt, { zone: timezone }).toFormat('LLL d')}`}
                  {l.createdBy && ` · by ${l.createdBy}`}
                </p>
              </div>
              <Badge tone={l.status === 'active' ? 'green' : l.status === 'used' ? 'blue' : 'neutral'}>{l.status}</Badge>
              {l.url && <CopyButton value={l.url} label="Copy" />}
              {l.status === 'active' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    try {
                      await api(`/api/scheduling-links/${l.id}`, { method: 'DELETE' });
                      toast.success('Link deactivated');
                      load();
                    } catch (err) {
                      toast.error(errorMessage(err));
                    }
                  }}
                >
                  Deactivate
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={created ? 'Link created' : 'New personal scheduling link'} description={created ? 'Send this link to your candidate.' : 'Optionally pre-fill the candidate’s details.'}>
          {created ? (
            <div className="space-y-4">
              <div className="break-all rounded-lg bg-zinc-50 p-3 font-mono text-sm text-zinc-800">{created}</div>
              <DialogFooter>
                <CopyButton value={created} variant="primary" size="md" />
              </DialogFooter>
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={async (e) => {
                e.preventDefault();
                const d = new FormData(e.currentTarget);
                setBusy(true);
                setErrors({});
                try {
                  const res = await api<{ url: string }>(`/api/event-types/${eventTypeId}/links`, {
                    body: {
                      label: d.get('label') || null,
                      candidateName: d.get('candidateName') || null,
                      candidateEmail: d.get('candidateEmail') || null,
                      maxUses: d.get('maxUses') === 'unlimited' ? null : Number(d.get('maxUses')),
                      expiresInDays: d.get('expires') === 'never' ? null : Number(d.get('expires')),
                    },
                  });
                  setCreated(res.url);
                  load();
                } catch (err) {
                  if (err instanceof ApiError) setErrors(err.fieldErrors);
                  toast.error(errorMessage(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Candidate name" htmlFor="candidateName" optionalTag>
                  <Input id="candidateName" name="candidateName" />
                </Field>
                <Field label="Candidate email" htmlFor="candidateEmail" optionalTag error={errors.candidateEmail}>
                  <Input id="candidateEmail" name="candidateEmail" type="email" />
                </Field>
              </div>
              <Field label="Internal label" htmlFor="label" optionalTag hint="Only visible to your team.">
                <Input id="label" name="label" placeholder="e.g. Senior backend — onsite loop" />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Can be used" htmlFor="maxUses">
                  <Select id="maxUses" name="maxUses" defaultValue="1">
                    <option value="1">Once</option>
                    <option value="2">Twice</option>
                    <option value="5">5 times</option>
                    <option value="unlimited">Unlimited</option>
                  </Select>
                </Field>
                <Field label="Expires" htmlFor="expires">
                  <Select id="expires" name="expires" defaultValue="14">
                    <option value="3">In 3 days</option>
                    <option value="7">In 7 days</option>
                    <option value="14">In 14 days</option>
                    <option value="30">In 30 days</option>
                    <option value="never">Never</option>
                  </Select>
                </Field>
              </div>
              <DialogFooter>
                <Button variant="secondary" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" loading={busy}>
                  Create link
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
