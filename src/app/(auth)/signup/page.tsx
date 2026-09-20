import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { SignupForm } from '@/components/app/auth-forms';
import { getAuth } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Create your account' };

export default async function SignupPage() {
  if (await getAuth()) redirect('/dashboard');
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Set up your hiring team</h1>
      <p className="mb-8 mt-1.5 text-sm text-zinc-500">
        For hiring teams. You’ll be the administrator of your organization once your account is approved. Candidates don’t need an account: use the booking link
        from your interviewer.
      </p>
      <SignupForm />
      <p className="mt-8 text-center text-sm text-zinc-500">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-brand-700 hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
