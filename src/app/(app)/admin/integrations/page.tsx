import { DateTime } from 'luxon';
import { CheckCircle2, XCircle } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { PageHeader } from '@/components/ui/page-header';
import { requireAdminPage } from '@/server/auth/page-guards';
import { db } from '@/server/db/client';
import { integrations, users } from '@/server/db/schema';
import { getSystemStatus } from '@/server/services/system-service';
import { and, eq } from 'drizzle-orm';

export const metadata: Metadata = { title: 'Integrations (admin)' };

export default async function AdminIntegrationsPage() {
  const auth = await requireAdminPage();
  const [rows, status] = await Promise.all([
    db
      .select({
        userId: users.id,
        name: users.name,
        provider: integrations.provider,
        status: integrations.status,
        accountEmail: integrations.externalAccountEmail,
        connectedAt: integrations.connectedAt,
        lastError: integrations.lastError,
      })
      .from(integrations)
      .innerJoin(users, eq(users.id, integrations.userId))
      .where(and(eq(integrations.organizationId, auth.organization.id)))
      .orderBy(users.name),
    getSystemStatus(),
  ]);
  const zone = auth.user.timezone;
  const Check = ({ ok }: { ok: boolean }) => (ok ? <CheckCircle2 className="size-4 text-emerald-600" /> : <XCircle className="size-4 text-rose-500" />);
  return (
    <>
      <PageHeader title="Integrations" description="Connection health for every team member, and the server-side OAuth configuration. Credentials are never shown." />
      <div className="grid gap-6 lg:grid-cols-2">
        {(
          [
            ['Google Calendar', status.google.configured, status.google.redirectUri, status.google.webhookUrl, status.google.pushSupported ? 'Push notifications enabled' : 'Push notifications need an https WEBHOOK_BASE_URL'],
            ['Zoom', status.zoom.configured, status.zoom.redirectUri, status.zoom.webhookUrl, status.zoom.webhookConfigured ? 'Webhook secret configured' : 'ZOOM_WEBHOOK_SECRET_TOKEN not set'],
          ] as const
        ).map(([name, configured, redirect, webhook, note]) => (
          <Card key={name}>
            <CardHeader title={name} action={<Badge tone={configured ? 'green' : 'amber'}>{configured ? 'OAuth configured' : 'Not configured'}</Badge>} />
            <CardBody className="space-y-3 text-sm">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">OAuth redirect URI</p>
                <div className="mt-1 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-zinc-50 px-2 py-1 text-xs">{redirect ?? '—'}</code>
                  {redirect && <CopyButton value={redirect} iconOnly label="Copy redirect URI" />}
                </div>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Webhook endpoint</p>
                <div className="mt-1 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-zinc-50 px-2 py-1 text-xs">{webhook}</code>
                  <CopyButton value={webhook} iconOnly label="Copy webhook URL" />
                </div>
              </div>
              <p className="text-xs text-zinc-500">{note}</p>
            </CardBody>
          </Card>
        ))}
      </div>

      <Card className="mt-6">
        <CardHeader title="Member connections" description={`${rows.filter((r) => r.status === 'active').length} active, ${rows.filter((r) => r.status !== 'active').length} need attention`} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-xs font-medium uppercase tracking-wide text-zinc-400">
                <th className="py-2.5 pl-5 pr-3 font-medium">Member</th>
                <th className="px-3 py-2.5 font-medium">Provider</th>
                <th className="px-3 py-2.5 font-medium">Account</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="py-2.5 pl-3 pr-5 font-medium">Connected</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-8 text-center text-zinc-500">
                    No one has connected an integration yet.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={`${r.userId}-${r.provider}`}>
                  <td className="py-3 pl-5 pr-3">
                    <Link href={`/admin/users/${r.userId}`} className="flex items-center gap-2 font-medium text-zinc-900 hover:underline">
                      <Avatar name={r.name} size="xs" /> {r.name}
                    </Link>
                  </td>
                  <td className="px-3 py-3 text-zinc-700">{r.provider === 'zoom' ? 'Zoom' : 'Google Calendar'}</td>
                  <td className="px-3 py-3 text-zinc-500">{r.accountEmail}</td>
                  <td className="px-3 py-3">
                    <span className="flex items-center gap-1.5">
                      <Check ok={r.status === 'active'} />
                      <span className={r.status === 'active' ? 'text-zinc-700' : 'text-rose-600'}>{r.status === 'active' ? 'Healthy' : (r.lastError ?? 'Error')}</span>
                    </span>
                  </td>
                  <td className="py-3 pl-3 pr-5 text-xs text-zinc-500">{DateTime.fromJSDate(r.connectedAt, { zone }).toFormat('LLL d, yyyy')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
