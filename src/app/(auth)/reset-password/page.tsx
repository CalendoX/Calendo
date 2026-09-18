import type { Metadata } from 'next';
import Link from 'next/link';
import { ResetPasswordForm } from '@/components/app/auth-forms';
import { Alert } from '@/components/ui/alert';
import { peekUserToken } from '@/server/services/auth-service';

export const metadata: Metadata = { title: 'Choose a new password' };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const valid = token ? await peekUserToken(token, 'password_reset') : null;
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Choose a new password</h1>
      <p className="mb-8 mt-1.5 text-sm text-zinc-500">{valid ? `For ${valid.user.email}` : 'Password reset'}</p>
      {valid && token ? (
        <ResetPasswordForm token={token} />
      ) : (
        <Alert tone="error" title="This link is invalid or has expired">
          Reset links work once and expire after an hour.{' '}
          <Link href="/forgot-password" className="font-medium underline">
            Request a new link
          </Link>
          .
        </Alert>
      )}
    </>
  );
}
