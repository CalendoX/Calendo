import { DateTime } from 'luxon';
import { CheckCircle2, XCircle } from 'lucide-react';
import type { Metadata } from 'next';
import { EmailDomainSettings } from '@/components/admin/email-domain-settings';
import { HolidaysManager, OrgSettingsForm, TemplatesEditor } from '@/components/admin/org-settings';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { LinkTabs } from '@/components/ui/tabs';
import { requireAdminPage } from '@/server/auth/page-guards';
import { db } from '@/server/db/client';
import { invitesCandidateAsCalendarGuest, organizations } from '@/server/db/schema';
import { DEFAULT_REMINDER_OFFSETS } from '@/server/notifications/planner';
import { getEmailDomain } from '@/server/services/email-domain-service';
import { listHolidays, listTemplates } from '@/server/services/organization-service';
import { getSystemStatus } from '@/server/services/system-service';
import { eq } from 'drizzle-orm';

export const metadata: Metadata = { title: 'System settings' };

const TABS = [
  { key: 'organization', label: 'Organization' },
  { key: 'holidays', label: 'Holidays' },
  { key: 'sending', label: 'Email sending' },
  { key: 'emails', label: 'Email templates' },
  { key: 'system', label: 'System status' },
];

export default async function AdminSettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const auth = await requireAdminPage();
  const { tab: t } = await searchParams;
  const tab = TABS.some((x) => x.key === t) ? t! : 'organization';
  const [org] = await db.select().from(organizations).where(eq(organizations.id, auth.organization.id));
  return (
    <>
      <PageHeader title="System settings" description="Organization-wide configuration and platform health." />
      <LinkTabs className="mb-6" tabs={TABS.map((x) => ({ ...x, href: `/admin/settings?tab=${x.key}` }))} active={tab} />
      {tab === 'organization' && (
        <OrgSettingsForm
          initial={{
            name: org.name,
            brandColor: org.brandColor,
            logoUrl: org.logoUrl,
            defaultTimezone: org.defaultTimezone,
            settings: {
              reminderOffsetsMinutes: org.settings.reminderOffsetsMinutes ?? DEFAULT_REMINDER_OFFSETS,
              candidateCanReschedule: org.settings.candidateCanReschedule !== false,
              candidateCanCancel: org.settings.candidateCanCancel !== false,
              candidateManageCutoffMinutes: org.settings.candidateManageCutoffMinutes ?? 0,
              addCandidateAsCalendarAttendee: invitesCandidateAsCalendarGuest(org.settings),
              bookingPageNotice: org.settings.bookingPageNotice ?? '',
            },
          }}
        />
      )}
      {tab === 'holidays' && <HolidaysManager holidays={await listHolidays(auth)} />}
      {tab === 'sending' && <EmailDomainSettings initial={await getEmailDomain(auth)} organizationName={org.name} />}
      {tab === 'emails' && <TemplatesEditor templates={await listTemplates(auth)} />}
      {tab === 'system' && <SystemStatus zone={auth.user.timezone} />}
    </>
  );
}

async function SystemStatus({ zone }: { zone: string }) {
  const s = await getSystemStatus();
  const Row = ({ label, ok, children }: { label: string; ok: boolean; children: React.ReactNode }) => (
    <li className="flex items-start justify-between gap-4 px-5 py-3 text-sm">
      <span className="flex items-center gap-2 font-medium text-zinc-800">
        {ok ? <CheckCircle2 className="size-4 text-emerald-600" /> : <XCircle className="size-4 text-rose-500" />} {label}
      </span>
      <span className="text-right text-zinc-500">{children}</span>
    </li>
  );
  const workerOk = Boolean(s.lastJobCompletedAt && Date.now() - Date.parse(s.lastJobCompletedAt) < 30 * 60 * 1000);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader title="Services" />
        <ul className="divide-y divide-zinc-100">
          <Row label="Database" ok={s.database.ok}>{s.database.ok ? `${s.database.latencyMs} ms` : 'Unreachable'}</Row>
          <Row label="Background worker" ok={workerOk}>
            {s.lastJobCompletedAt ? `Last job ${DateTime.fromISO(s.lastJobCompletedAt).toRelative()}` : 'No jobs completed in 24h — is `npm run worker` running?'}
          </Row>
          <Row label="Email" ok={s.email.provider !== 'console' || s.environment !== 'production'}>
            {s.email.provider}
            {s.email.smtpHost ? ` via ${s.email.smtpHost}` : ''} · {s.email.from}
          </Row>
          <Row label="Google Calendar OAuth" ok={s.google.configured}>{s.google.configured ? 'Configured' : 'Missing credentials'}</Row>
          <Row label="Zoom OAuth" ok={s.zoom.configured}>{s.zoom.configured ? 'Configured' : 'Missing credentials'}</Row>
          <Row label="Zoom webhooks" ok={s.zoom.webhookConfigured}>{s.zoom.webhookConfigured ? 'Signature secret set' : 'Secret not set'}</Row>
          <Row label="Google push notifications" ok={s.google.pushSupported}>{s.google.pushSupported ? 'Enabled' : 'Requires https WEBHOOK_BASE_URL'}</Row>
        </ul>
        <CardBody className="border-t border-zinc-100 text-xs text-zinc-500">
          App URL <code className="rounded bg-zinc-50 px-1">{s.appUrl}</code> · environment {s.environment} · times shown in {zone.replace(/_/g, ' ')}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Job queues" description={s.queueError ?? 'Background jobs with automatic retry and backoff'} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-400">
                <th className="py-2 pl-5 pr-3 font-medium">Queue</th>
                <th className="px-3 py-2 text-right font-medium">Ready</th>
                <th className="px-3 py-2 text-right font-medium">Scheduled</th>
                <th className="px-3 py-2 text-right font-medium">Active</th>
                <th className="py-2 pl-3 pr-5 text-right font-medium">Failed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {s.queues.map((q) => (
                <tr key={q.name}>
                  <td className="py-2 pl-5 pr-3 font-mono text-xs text-zinc-700">{q.name}</td>
                  <td className="tabular px-3 py-2 text-right">{q.ready}</td>
                  <td className="tabular px-3 py-2 text-right">{q.deferred}</td>
                  <td className="tabular px-3 py-2 text-right">{q.active}</td>
                  <td className="tabular py-2 pl-3 pr-5 text-right">{q.failed ? <Badge tone="red">{q.failed}</Badge> : 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <CardBody className="border-t border-zinc-100">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">Webhooks (last 7 days)</p>
          {s.webhooks.length === 0 ? (
            <p className="text-sm text-zinc-500">No webhook deliveries.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {s.webhooks.map((w) => (
                <Badge key={`${w.provider}-${w.status}`} tone={w.status === 'failed' ? 'red' : w.status === 'processed' ? 'green' : 'neutral'}>
                  {w.provider === 'zoom' ? 'Zoom' : 'Google'} {w.status}: {w.n}
                </Badge>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
