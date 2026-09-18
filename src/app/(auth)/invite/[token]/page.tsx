import type { Metadata } from 'next';
import Link from 'next/link';
import { AcceptInviteForm } from '@/components/app/auth-forms';
import { Alert } from '@/components/ui/alert';
import { peekUserToken } from '@/server/services/auth-service';

export const metadata: Metadata = { title: 'Accept invitation' };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await peekUserToken(token, 'invitation');
  if (!invite) {
    return (
      <>
        <h1 className="mb-6 text-2xl font-semibold tracking-tight text-zinc-900">Invitation</h1>
        <Alert tone="error" title="This invitation is invalid or has expired">
          Ask your administrator to send a new invitation, or{' '}
          <Link href="/login" className="font-medium underline">
            sign in
          </Link>{' '}
          if you already have an account.
        </Alert>
      </>
    );
  }
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Join {invite.organization?.name ?? 'your team'}</h1>
      <p className="mb-8 mt-1.5 text-sm text-zinc-500">Set up your account to start scheduling interviews.</p>
      <AcceptInviteForm token={token} name={invite.user.name} email={invite.user.email} />
    </>
  );
}
