import type { Metadata } from 'next';
import Link from 'next/link';
import { ActivityList } from '@/components/admin/activity-list';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Pagination } from '@/components/ui/pagination';
import { Button } from '@/components/ui/button';
import { requireAdminPage } from '@/server/auth/page-guards';
import { listAuditLogs } from '@/server/services/interviews-service';

export const metadata: Metadata = { title: 'Audit log' };

const CATEGORIES = [
  ['', 'All activity'],
  ['interview.', 'Interviews'],
  ['integration.', 'Integrations'],
  ['user.', 'Users'],
  ['auth.', 'Authentication'],
  ['event_type.', 'Event types'],
  ['availability.', 'Availability'],
  ['organization.', 'Organization'],
  ['scheduling_link.', 'Scheduling links'],
] as const;

export default async function AuditLogPage({ searchParams }: { searchParams: Promise<{ q?: string; action?: string; page?: string }> }) {
  const auth = await requireAdminPage();
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const result = await listAuditLogs(auth, { q: sp.q?.slice(0, 100), action: sp.action?.slice(0, 60), page, pageSize: 50 });
  const href = (p: number) => {
    const qs = new URLSearchParams();
    if (sp.q) qs.set('q', sp.q);
    if (sp.action) qs.set('action', sp.action);
    qs.set('page', String(p));
    return `/admin/audit-log?${qs}`;
  };
  return (
    <>
      <PageHeader title="Audit log" description="An immutable record of every important action: bookings, changes, sign-ins, integrations and admin actions." />
      <Card>
        <form className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-4 py-3" action="/admin/audit-log">
          <Input name="q" defaultValue={sp.q ?? ''} placeholder="Search actor, email, details…" className="max-w-xs" aria-label="Search audit log" />
          <Select name="action" defaultValue={sp.action ?? ''} className="w-auto" aria-label="Category">
            {CATEGORIES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="secondary">
            Filter
          </Button>
          {(sp.q || sp.action) && (
            <Link href="/admin/audit-log" className="text-sm text-zinc-500 hover:text-zinc-800">
              Clear
            </Link>
          )}
        </form>
        <ActivityList items={result.items} zone={auth.user.timezone} />
        <div className="border-t border-zinc-100 px-4">
          <Pagination page={result.page} pageSize={result.pageSize} total={result.total} hrefFor={href} />
        </div>
      </Card>
    </>
  );
}
