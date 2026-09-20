import { AppShell } from '@/components/app/app-shell';
import { requirePageAuth } from '@/server/auth/page-guards';
import { isPlatformAdmin } from '@/server/authz/policy';
import { env } from '@/server/config/env';
import { countSignupRequests } from '@/server/services/signup-approval-service';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const auth = await requirePageAuth();
  const platform = isPlatformAdmin(auth) ? { pendingSignups: await countSignupRequests() } : null;
  return (
    <AppShell
      user={{ name: auth.user.name, email: auth.user.email, username: auth.user.username, emailVerified: Boolean(auth.user.emailVerifiedAt) }}
      organization={{ id: auth.organization.id, name: auth.organization.name }}
      role={auth.membership.role}
      organizations={auth.memberships}
      appUrl={env().APP_URL}
      platform={platform}
    >
      {children}
    </AppShell>
  );
}
