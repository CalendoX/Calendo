import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SignupRequests } from '@/components/platform/signup-requests';
import { PageHeader } from '@/components/ui/page-header';
import { requirePageAuth } from '@/server/auth/page-guards';
import { isPlatformAdmin } from '@/server/authz/policy';
import { listSignupRequests } from '@/server/services/signup-approval-service';

export const metadata: Metadata = { title: 'Sign-up requests' };

export default async function SignupRequestsPage() {
  const auth = await requirePageAuth('/platform/signups');
  // Everyone except platform admins gets a 404 (no information disclosure).
  if (!isPlatformAdmin(auth)) notFound();
  return (
    <>
      <PageHeader title="Sign-up requests" description="People who signed up to create a new organization. They can’t sign in until you approve them." />
      <SignupRequests requests={await listSignupRequests(auth)} />
    </>
  );
}
