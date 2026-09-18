import { notFound, redirect } from 'next/navigation';
import { getAuth, type AuthContext } from './session';

/** For server components: the current auth context or a redirect to /login. */
export async function requirePageAuth(next?: string): Promise<AuthContext> {
  const auth = await getAuth();
  if (!auth) redirect(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
  return auth;
}

/** Admin-only pages render 404 for everyone else (no information disclosure). */
export async function requireAdminPage(): Promise<AuthContext> {
  const auth = await requirePageAuth();
  if (auth.membership.role !== 'admin') notFound();
  return auth;
}

export function safeNextPath(next: string | string[] | undefined): string {
  const value = Array.isArray(next) ? next[0] : next;
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/dashboard';
  return value;
}
