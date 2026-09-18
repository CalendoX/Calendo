import type { Metadata } from 'next';
import { UsersAdmin } from '@/components/admin/users-admin';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { requireAdminPage } from '@/server/auth/page-guards';
import { listMembers } from '@/server/services/team-service';

export const metadata: Metadata = { title: 'Users' };

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<{ q?: string; role?: string; status?: string; invite?: string }> }) {
  const auth = await requireAdminPage();
  const sp = await searchParams;
  const role = sp.role === 'admin' || sp.role === 'recruiter' || sp.role === 'interviewer' ? sp.role : undefined;
  const members = await listMembers(auth, { search: sp.q?.slice(0, 100), role, status: sp.status });
  return (
    <>
      <PageHeader title="Users" description="Create accounts, manage roles and control access to your organization." />
      <Card>
        <UsersAdmin members={members} currentUserId={auth.user.id} openInvite={sp.invite === '1'} />
      </Card>
    </>
  );
}
