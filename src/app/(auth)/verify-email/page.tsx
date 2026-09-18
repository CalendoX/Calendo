import type { Metadata } from 'next';
import { VerifyEmail } from '@/components/app/auth-forms';
import { Alert } from '@/components/ui/alert';

export const metadata: Metadata = { title: 'Verify email' };

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight text-zinc-900">Verify your email</h1>
      {token ? <VerifyEmail token={token} /> : <Alert tone="error">Missing verification token.</Alert>}
    </>
  );
}
