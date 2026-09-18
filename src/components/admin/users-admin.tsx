'use client';

import { DateTime } from 'luxon';
import { MoreHorizontal, Search, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Dropdown, DropdownContent, DropdownItem, DropdownLabel, DropdownSeparator, DropdownTrigger } from '@/components/ui/dropdown';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { api, ApiError, errorMessage } from '@/lib/api-client';

type Role = 'admin' | 'recruiter' | 'interviewer';
export interface AdminMember {
  userId: string;
  name: string;
  email: string;
  title: string | null;
  role: Role;
  status: 'active' | 'invited' | 'deactivated';
  emailVerified: boolean;
  lastLoginAt: string | null;
  joinedAt: string;
  integrations: { provider: string; status: string }[];
  upcomingInterviews: number;
  totalInterviews: number;
  eventTypes: number;
}

const ROLE_LABEL: Record<Role, string> = { admin: 'Admin', recruiter: 'Recruiter', interviewer: 'Interviewer' };
const ROLE_HINT: Record<Role, string> = {
  admin: 'Full access: users, settings, all interviews and the audit log.',
  recruiter: 'Manages their own setup, and can view and manage every interview in the organization.',
  interviewer: 'Manages their own event types, availability, integrations and interviews.',
};

export function UsersAdmin({ members, currentUserId, openInvite }: { members: AdminMember[]; currentUserId: string; openInvite: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [inviteOpen, setInviteOpen] = useState(openInvite);
  const [confirm, setConfirm] = useState<{ member: AdminMember; action: 'deactivate' | 'activate' } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (q.trim()) next.set('q', q.trim());
      else next.delete('q');
      next.delete('invite');
      if (next.toString() !== params.toString()) router.replace(`${pathname}?${next}`);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  async function patch(member: AdminMember, body: Record<string, unknown>, success: string) {
    try {
      await api(`/api/admin/users/${member.userId}`, { method: 'PATCH', body });
      toast.success(success);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-4 py-3">
        <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or email…" className="pl-9" aria-label="Search users" />
        </div>
        <Select
          aria-label="Role"
          className="w-auto"
          value={params.get('role') ?? ''}
          onChange={(e) => {
            const next = new URLSearchParams(params.toString());
            if (e.target.value) next.set('role', e.target.value);
            else next.delete('role');
            router.replace(`${pathname}?${next}`);
          }}
        >
          <option value="">All roles</option>
          <option value="admin">Admins</option>
          <option value="recruiter">Recruiters</option>
          <option value="interviewer">Interviewers</option>
        </Select>
        <Select
          aria-label="Status"
          className="w-auto"
          value={params.get('status') ?? ''}
          onChange={(e) => {
            const next = new URLSearchParams(params.toString());
            if (e.target.value) next.set('status', e.target.value);
            else next.delete('status');
            router.replace(`${pathname}?${next}`);
          }}
        >
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="invited">Invited</option>
          <option value="deactivated">Deactivated</option>
        </Select>
        <Button className="ml-auto" onClick={() => setInviteOpen(true)}>
          <UserPlus /> Add user
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b border-zinc-100 text-left text-xs font-medium uppercase tracking-wide text-zinc-400">
              <th className="py-2.5 pl-5 pr-3 font-medium">User</th>
              <th className="px-3 py-2.5 font-medium">Role</th>
              <th className="px-3 py-2.5 font-medium">Status</th>
              <th className="px-3 py-2.5 font-medium">Integrations</th>
              <th className="px-3 py-2.5 text-right font-medium">Upcoming</th>
              <th className="px-3 py-2.5 text-right font-medium">Total</th>
              <th className="px-3 py-2.5 font-medium">Last sign-in</th>
              <th className="py-2.5 pl-3 pr-5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {members.map((m) => (
              <tr key={m.userId} className="hover:bg-zinc-50/70">
                <td className="py-3 pl-5 pr-3">
                  <Link href={`/admin/users/${m.userId}`} className="flex items-center gap-3">
                    <Avatar name={m.name} size="sm" />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-zinc-900 hover:underline">
                        {m.name} {m.userId === currentUserId && <span className="font-normal text-zinc-400">(you)</span>}
                      </span>
                      <span className="block truncate text-xs text-zinc-500">{m.email}</span>
                    </span>
                  </Link>
                </td>
                <td className="px-3 py-3">
                  <Badge tone={m.role === 'admin' ? 'violet' : m.role === 'recruiter' ? 'blue' : 'neutral'}>{ROLE_LABEL[m.role]}</Badge>
                </td>
                <td className="px-3 py-3">
                  <Badge tone={m.status === 'active' ? 'green' : m.status === 'invited' ? 'amber' : 'red'} dot>
                    {m.status === 'active' ? 'Active' : m.status === 'invited' ? 'Invited' : 'Deactivated'}
                  </Badge>
                </td>
                <td className="px-3 py-3">
                  <span className="flex gap-1">
                    {m.integrations.length === 0 && <span className="text-xs text-zinc-400">None</span>}
                    {m.integrations.map((i) => (
                      <Badge key={i.provider} tone={i.status === 'active' ? 'green' : 'red'}>
                        {i.provider === 'zoom' ? 'Zoom' : 'Google'}
                      </Badge>
                    ))}
                  </span>
                </td>
                <td className="tabular px-3 py-3 text-right text-zinc-700">{m.upcomingInterviews}</td>
                <td className="tabular px-3 py-3 text-right text-zinc-700">{m.totalInterviews}</td>
                <td className="px-3 py-3 text-xs text-zinc-500">{m.lastLoginAt ? DateTime.fromISO(m.lastLoginAt).toRelative() : 'Never'}</td>
                <td className="py-3 pl-3 pr-5 text-right">
                  <Dropdown>
                    <DropdownTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${m.name}`}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownTrigger>
                    <DropdownContent>
                      <DropdownItem asChild>
                        <Link href={`/admin/users/${m.userId}`}>View details</Link>
                      </DropdownItem>
                      <DropdownLabel>Change role</DropdownLabel>
                      {(['admin', 'recruiter', 'interviewer'] as Role[])
                        .filter((r) => r !== m.role)
                        .map((r) => (
                          <DropdownItem key={r} disabled={m.userId === currentUserId} onSelect={() => patch(m, { role: r }, `${m.name} is now ${ROLE_LABEL[r].toLowerCase()}`)}>
                            Make {ROLE_LABEL[r].toLowerCase()}
                          </DropdownItem>
                        ))}
                      <DropdownSeparator />
                      {m.status === 'invited' && (
                        <DropdownItem
                          onSelect={async () => {
                            try {
                              await api(`/api/admin/users/${m.userId}/resend-invite`, { body: {} });
                              toast.success(`Invitation re-sent to ${m.email}`);
                            } catch (err) {
                              toast.error(errorMessage(err));
                            }
                          }}
                        >
                          Resend invitation
                        </DropdownItem>
                      )}
                      {m.status === 'deactivated' ? (
                        <DropdownItem onSelect={() => setConfirm({ member: m, action: 'activate' })}>Reactivate</DropdownItem>
                      ) : (
                        <DropdownItem destructive disabled={m.userId === currentUserId} onSelect={() => setConfirm({ member: m, action: 'deactivate' })}>
                          Deactivate
                        </DropdownItem>
                      )}
                    </DropdownContent>
                  </Dropdown>
                </td>
              </tr>
            ))}
            {members.length === 0 && (
              <tr>
                <td colSpan={8} className="px-5 py-10 text-center text-sm text-zinc-500">
                  No users match your filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <ConfirmDialog
        open={Boolean(confirm)}
        onOpenChange={(o) => !o && setConfirm(null)}
        tone={confirm?.action === 'activate' ? 'primary' : 'danger'}
        title={confirm?.action === 'activate' ? `Reactivate ${confirm?.member.name}?` : `Deactivate ${confirm?.member.name}?`}
        description={
          confirm?.action === 'activate'
            ? 'They will be able to sign in again and their booking pages will accept interviews.'
            : 'They are signed out immediately and their booking pages stop accepting interviews. Existing interviews are not cancelled.'
        }
        confirmLabel={confirm?.action === 'activate' ? 'Reactivate' : 'Deactivate'}
        onConfirm={async () => {
          if (!confirm) return;
          await patch(confirm.member, { status: confirm.action === 'activate' ? 'active' : 'deactivated' }, confirm.action === 'activate' ? 'User reactivated' : 'User deactivated');
          setConfirm(null);
        }}
      />
    </>
  );
}

function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const [role, setRole] = useState<Role>('interviewer');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setInviteUrl(null);
      }}
    >
      <DialogContent title={inviteUrl ? 'Invitation sent' : 'Add a user'} description={inviteUrl ? 'They’ve been emailed a link to set their password. You can also share it directly.' : 'Create an account for an interviewer, recruiter or admin. They’ll receive an email to set their password.'}>
        {inviteUrl ? (
          <>
            <div className="break-all rounded-lg bg-zinc-50 p-3 font-mono text-xs text-zinc-700">{inviteUrl}</div>
            <DialogFooter>
              <CopyButton value={inviteUrl} label="Copy invite link" />
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              const d = new FormData(e.currentTarget);
              setBusy(true);
              setErrors({});
              try {
                const res = await api<{ inviteUrl: string | null }>('/api/admin/users', { body: { name: d.get('name'), email: d.get('email'), title: d.get('title') || null, role } });
                router.refresh();
                if (res.inviteUrl) setInviteUrl(res.inviteUrl);
                else {
                  toast.success('Existing user added to your organization');
                  onOpenChange(false);
                }
              } catch (err) {
                if (err instanceof ApiError) setErrors(err.fieldErrors);
                toast.error(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Full name" htmlFor="inv-name" error={errors.name}>
                <Input id="inv-name" name="name" required />
              </Field>
              <Field label="Work email" htmlFor="inv-email" error={errors.email}>
                <Input id="inv-email" name="email" type="email" required />
              </Field>
            </div>
            <Field label="Job title" htmlFor="inv-title" optionalTag>
              <Input id="inv-title" name="title" placeholder="Senior Engineer" />
            </Field>
            <Field label="Role">
              <div className="space-y-2">
                {(['interviewer', 'recruiter', 'admin'] as Role[]).map((r) => (
                  <label key={r} className={`flex cursor-pointer gap-3 rounded-xl border p-3 ${role === r ? 'border-brand-600 bg-brand-50/50 ring-1 ring-brand-600' : 'border-zinc-200'}`}>
                    <input type="radio" name="role" value={r} checked={role === r} onChange={() => setRole(r)} className="mt-1 accent-brand-600" />
                    <span>
                      <span className="block text-sm font-medium text-zinc-900">{ROLE_LABEL[r]}</span>
                      <span className="block text-xs text-zinc-500">{ROLE_HINT[r]}</span>
                    </span>
                  </label>
                ))}
              </div>
            </Field>
            <DialogFooter>
              <Button variant="secondary" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={busy}>
                Send invitation
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
