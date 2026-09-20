'use client';

import { UserCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { RelativeTime } from '@/components/ui/relative-time';
import { api, errorMessage } from '@/lib/api-client';

export interface SignupRequestDto {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  organizationName: string | null;
  requestedAt: string;
}

export function SignupRequests({ requests }: { requests: SignupRequestDto[] }) {
  const router = useRouter();
  const [items, setItems] = useState(requests);
  const [busy, setBusy] = useState<string | null>(null);
  const [declining, setDeclining] = useState<SignupRequestDto | null>(null);

  async function act(r: SignupRequestDto, action: 'approve' | 'decline') {
    setBusy(r.id);
    try {
      await api(`/api/platform/signups/${r.id}/${action}`, { method: 'POST', body: {} });
      setItems((list) => list.filter((x) => x.id !== r.id));
      toast.success(action === 'approve' ? `${r.name} approved — they’ve been emailed that they can sign in` : `${r.name}’s request was declined and removed`);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
      setDeclining(null);
    }
  }

  if (items.length === 0) {
    return (
      <Card>
        <EmptyState icon={<UserCheck />} title="No pending requests" description="When someone signs up to create a new organization, their request appears here and you get an email." />
      </Card>
    );
  }

  return (
    <Card>
      <ul className="divide-y divide-zinc-100">
        {items.map((r) => (
          <li key={r.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <Avatar name={r.name} />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-zinc-900">
                  {r.name} <span className="font-normal text-zinc-500">· {r.organizationName ?? 'No organization'}</span>
                </p>
                <p className="flex flex-wrap items-center gap-2 text-sm text-zinc-500">
                  <span className="truncate">{r.email}</span>
                  {r.emailVerified ? <Badge tone="green">Email verified</Badge> : <Badge tone="amber">Email not verified</Badge>}
                  <span className="text-xs text-zinc-400">
                    requested <RelativeTime iso={r.requestedAt} />
                  </span>
                </p>
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="danger-outline" size="sm" disabled={busy !== null} onClick={() => setDeclining(r)}>
                Decline
              </Button>
              <Button size="sm" loading={busy === r.id && !declining} disabled={busy !== null} onClick={() => act(r, 'approve')}>
                Approve
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={Boolean(declining)}
        onOpenChange={(o) => !o && setDeclining(null)}
        title={`Decline ${declining?.name ?? ''}?`}
        description={`Their pending account and the organization “${declining?.organizationName ?? ''}” will be deleted, and they’ll get an email saying the request wasn’t approved.`}
        confirmLabel="Decline request"
        onConfirm={async () => {
          if (declining) await act(declining, 'decline');
        }}
      />
    </Card>
  );
}
