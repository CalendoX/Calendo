import type { Metadata } from 'next';
import Link from 'next/link';
import { PasswordForm, ProfileForm } from '@/components/app/settings-forms';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { requirePageAuth } from '@/server/auth/page-guards';
import { ROLE_LABELS } from '@/server/authz/policy';
import { appUrl } from '@/server/config/env';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const auth = await requirePageAuth('/settings');
  return (
    <>
      <PageHeader title="Settings" description="Your personal profile and security settings." />
      <div className="space-y-6">
        <ProfileForm initial={{ name: auth.user.name, title: auth.user.title, timezone: auth.user.timezone, username: auth.user.username, email: auth.user.email }} appUrl={appUrl()} />
        <PasswordForm />
        <Card>
          <CardHeader title="Organization" />
          <CardBody className="flex flex-wrap items-center justify-between gap-4 text-sm">
            <div>
              <p className="font-medium text-zinc-900">{auth.organization.name}</p>
              <p className="text-zinc-500">Your role: {ROLE_LABELS[auth.membership.role]}</p>
            </div>
            {auth.membership.role === 'admin' && (
              <Link href="/admin/settings" className="font-medium text-brand-700 hover:underline">
                Organization settings →
              </Link>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
