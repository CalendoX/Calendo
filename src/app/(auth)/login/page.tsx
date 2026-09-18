import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/app/auth-forms';
import { safeNextPath } from '@/server/auth/page-guards';
import { getAuth } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const target = safeNextPath(next);
  if (await getAuth()) redirect(target);
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Welcome back</h1>
      <p className="mb-8 mt-1.5 text-sm text-zinc-500">Sign in to manage your interviews.</p>
      <LoginForm next={target} />
      <p className="mt-8 text-center text-sm text-zinc-500">
        New to Slate?{' '}
        <Link href="/signup" className="font-medium text-brand-700 hover:underline">
          Create an account
        </Link>
      </p>
    </>
  );
}
