import type { Metadata } from 'next';
import { InterviewsBrowser } from '@/components/interviews/interviews-browser';
import { requirePageAuth } from '@/server/auth/page-guards';

export const metadata: Metadata = { title: 'Scheduled interviews' };

export default async function InterviewsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const auth = await requirePageAuth('/interviews');
  return <InterviewsBrowser auth={auth} sp={await searchParams} basePath="/interviews" />;
}
