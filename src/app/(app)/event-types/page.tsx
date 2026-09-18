import { Layers, Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { EventTypeCard } from '@/components/event-types/event-type-card';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { requirePageAuth } from '@/server/auth/page-guards';
import { appUrl } from '@/server/config/env';
import { listEventTypes } from '@/server/services/event-types-service';

export const metadata: Metadata = { title: 'Event types' };

export default async function EventTypesPage() {
  const auth = await requirePageAuth('/event-types');
  const items = await listEventTypes(auth, { scope: 'mine' });
  const profileUrl = appUrl(`/schedule/${auth.user.username}`);
  return (
    <>
      <PageHeader
        title="Event types"
        description="Interview formats candidates can book with you. Each one has its own scheduling link."
        actions={
          <Button asChild>
            <Link href="/event-types/new">
              <Plus /> New event type
            </Link>
          </Button>
        }
      />
      <Card className="mb-6 flex flex-wrap items-center gap-4 p-4">
        <Avatar name={auth.user.name} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-zinc-900">{auth.user.name}</p>
          <a href={profileUrl} target="_blank" rel="noreferrer" className="block truncate text-sm text-brand-700 hover:underline">
            {profileUrl.replace(/^https?:\/\//, '')}
          </a>
        </div>
        <CopyButton value={profileUrl} label="Copy booking page link" />
      </Card>
      {items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Layers />}
            title="Create your first interview type"
            description="For example a 60-minute Technical Interview on Zoom. Candidates pick a time that fits your availability."
            action={
              <Button asChild>
                <Link href="/event-types/new">
                  <Plus /> New event type
                </Link>
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <EventTypeCard key={item.id} item={item} canManage />
          ))}
        </div>
      )}
    </>
  );
}
