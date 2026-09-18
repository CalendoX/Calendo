import { ExternalLink, UserPlus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { requirePageAuth } from '@/server/auth/page-guards';
import { ROLE_LABELS } from '@/server/authz/policy';
import { appUrl } from '@/server/config/env';
import { listMembers } from '@/server/services/team-service';

export const metadata: Metadata = { title: 'Team' };

export default async function TeamPage() {
  const auth = await requirePageAuth('/team');
  const members = await listMembers(auth);
  const admin = auth.membership.role === 'admin';
  return (
    <>
      <PageHeader
        title="Team"
        description={`Everyone who schedules interviews at ${auth.organization.name}.`}
        actions={
          admin && (
            <Button asChild>
              <Link href="/admin/users?invite=1">
                <UserPlus /> Invite teammate
              </Link>
            </Button>
          )
        }
      />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {members.map((m) => (
          <Card key={m.userId} className="p-5">
            <div className="flex items-start gap-3">
              <Avatar name={m.name} size="lg" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-zinc-900">
                  {m.name} {m.userId === auth.user.id && <span className="font-normal text-zinc-400">(you)</span>}
                </p>
                <p className="truncate text-sm text-zinc-500">{m.title ?? m.email}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Badge tone={m.role === 'admin' ? 'violet' : m.role === 'recruiter' ? 'blue' : 'neutral'}>{ROLE_LABELS[m.role]}</Badge>
                  {m.status !== 'active' && <Badge tone="amber">{m.status === 'invited' ? 'Invited' : 'Deactivated'}</Badge>}
                  {m.integrations.map((i) => (
                    <Badge key={i.provider} tone={i.status === 'active' ? 'green' : 'red'}>
                      {i.provider === 'zoom' ? 'Zoom' : 'Google'}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 border-t border-zinc-100 pt-3 text-center">
              <div>
                <p className="tabular text-lg font-semibold text-zinc-900">{m.upcomingInterviews}</p>
                <p className="text-xs text-zinc-500">Upcoming</p>
              </div>
              <div>
                <p className="tabular text-lg font-semibold text-zinc-900">{m.totalInterviews}</p>
                <p className="text-xs text-zinc-500">Total</p>
              </div>
              <div>
                <p className="tabular text-lg font-semibold text-zinc-900">{m.eventTypes}</p>
                <p className="text-xs text-zinc-500">Event types</p>
              </div>
            </div>
            {m.status === 'active' && (
              <a href={appUrl(`/schedule/${m.username}`)} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline">
                Booking page <ExternalLink className="size-3.5" />
              </a>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
