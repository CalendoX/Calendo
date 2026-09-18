import { Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { EventTypeCard } from '@/components/event-types/event-type-card';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { requireAdminPage } from '@/server/auth/page-guards';
import { listEventTypes } from '@/server/services/event-types-service';

export const metadata: Metadata = { title: 'Event types (admin)' };

export default async function AdminEventTypesPage() {
  const auth = await requireAdminPage();
  const items = await listEventTypes(auth, { scope: 'all' });
  const byHost = new Map<string, typeof items>();
  for (const i of items) (byHost.get(i.host.name) ?? byHost.set(i.host.name, []).get(i.host.name)!).push(i);
  return (
    <>
      <PageHeader
        title="Event types"
        description={`All ${items.length} interview types across your organization.`}
        actions={
          <Button asChild>
            <Link href="/event-types/new">
              <Plus /> New event type
            </Link>
          </Button>
        }
      />
      <div className="space-y-8">
        {[...byHost.entries()].map(([host, list]) => (
          <section key={host}>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">{host}</h2>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {list.map((item) => (
                <EventTypeCard key={item.id} item={item} canManage />
              ))}
            </div>
          </section>
        ))}
        {items.length === 0 && <p className="text-sm text-zinc-500">No event types yet.</p>}
      </div>
    </>
  );
}
