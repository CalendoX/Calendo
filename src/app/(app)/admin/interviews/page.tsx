import type { Metadata } from 'next';
import { InterviewsBrowser } from '@/components/interviews/interviews-browser';
import { requireAdminPage } from '@/server/auth/page-guards';

export const metadata: Metadata = { title: 'All interviews' };

export default async function AdminInterviewsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const auth = await requireAdminPage();
  return <InterviewsBrowser auth={auth} sp={await searchParams} basePath="/admin/interviews" admin />;
}
