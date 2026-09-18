import type { Metadata } from 'next';
import { IntegrationCard } from '@/components/integrations/integration-card';
import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/page-header';
import { requirePageAuth } from '@/server/auth/page-guards';
import { listIntegrationsForUser } from '@/server/integrations/connections';
import { pushNotificationsSupported } from '@/server/integrations/google/watch';

export const metadata: Metadata = { title: 'Integrations' };

const ERRORS: Record<string, string> = {
  access_denied: 'You declined the authorization request, so nothing was connected.',
  oauth_error: 'The provider returned an error during authorization. Please try again.',
  missing_code: 'The authorization response was incomplete. Please try again.',
  connect_failed: 'We couldn’t finish connecting the account.',
  unknown_provider: 'Unknown integration.',
};

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string; message?: string; provider?: string }> }) {
  const auth = await requirePageAuth('/integrations');
  const sp = await searchParams;
  const items = await listIntegrationsForUser(auth.user.id);
  const push = pushNotificationsSupported();
  return (
    <>
      <PageHeader title="Integrations" description="Connect your calendar and video conferencing. Credentials are encrypted and never leave the server." />
      {sp.connected && (
        <Alert tone="success" className="mb-6" title={`${sp.connected === 'google' ? 'Google Calendar' : 'Zoom'} connected`}>
          {sp.connected === 'google' ? 'Your primary calendar is now checked for conflicts and receives new interviews. Adjust below.' : 'New Zoom interviews will get a meeting link automatically. Pending interviews are being updated now.'}
        </Alert>
      )}
      {sp.error && (
        <Alert tone="error" className="mb-6" title="Connection failed">
          {sp.message ?? ERRORS[sp.error] ?? 'Something went wrong.'}
        </Alert>
      )}
      <div className="space-y-5">
        {items.map((i) => (
          <IntegrationCard key={i.provider} integration={i} pushNotifications={push} />
        ))}
      </div>
    </>
  );
}
