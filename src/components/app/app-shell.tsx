'use client';

import {
  CalendarCheck2,
  CalendarDays,
  ChevronsUpDown,
  Clock,
  ExternalLink,
  Gauge,
  Layers,
  ListChecks,
  LogOut,
  Menu,
  Plug,
  ScrollText,
  Settings,
  SlidersHorizontal,
  UserCheck,
  UserCog,
  Users,
  LayoutDashboard,
  PlugZap,
  X,
  Check,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Dropdown, DropdownContent, DropdownItem, DropdownLabel, DropdownSeparator, DropdownTrigger } from '@/components/ui/dropdown';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { Logo } from './logo';

export interface ShellUser {
  name: string;
  email: string;
  username: string;
  emailVerified: boolean;
}

export interface ShellOrg {
  id: string;
  name: string;
}

type NavItem = { href: string; label: string; icon: React.ComponentType<{ className?: string }>; exact?: boolean; count?: number };

const MAIN: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/interviews', label: 'Scheduled interviews', icon: CalendarCheck2 },
  { href: '/calendar', label: 'Calendar', icon: CalendarDays },
];
const SETUP: NavItem[] = [
  { href: '/event-types', label: 'Event types', icon: Layers },
  { href: '/availability', label: 'Availability', icon: Clock },
  { href: '/integrations', label: 'Integrations', icon: Plug },
];
const ORG: NavItem[] = [
  { href: '/team', label: 'Team', icon: Users },
  { href: '/settings', label: 'Settings', icon: Settings },
];
const ADMIN: NavItem[] = [
  { href: '/admin', label: 'Overview', icon: Gauge, exact: true },
  { href: '/admin/interviews', label: 'All interviews', icon: ListChecks },
  { href: '/admin/users', label: 'Users', icon: UserCog },
  { href: '/admin/event-types', label: 'Event types', icon: Layers },
  { href: '/admin/integrations', label: 'Integrations', icon: PlugZap },
  { href: '/admin/settings', label: 'System settings', icon: SlidersHorizontal },
  { href: '/admin/audit-log', label: 'Audit log', icon: ScrollText },
];

function NavGroup({ title, items, pathname, onNavigate }: { title?: string; items: NavItem[]; pathname: string; onNavigate?: () => void }) {
  return (
    <div className="space-y-0.5">
      {title && <p className="px-3 pb-1.5 pt-4 text-[11px] font-semibold uppercase tracking-wider text-sidebar-muted/70">{title}</p>}
      {items.map((item) => {
        const active = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'group flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] font-medium transition-colors',
              active ? 'bg-white/[0.09] text-white' : 'text-sidebar-muted hover:bg-white/[0.05] hover:text-white',
            )}
          >
            <Icon className={cn('size-[17px] shrink-0', active ? 'text-brand-300' : 'text-sidebar-muted/80 group-hover:text-white/80')} />
            <span className="truncate">{item.label}</span>
            {Boolean(item.count) && (
              <span className="ml-auto rounded-full bg-brand-500 px-1.5 text-[11px] font-semibold leading-5 text-white" aria-label={`${item.count} pending`}>
                {item.count}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}

export function AppShell({
  user,
  organization,
  role,
  organizations,
  appUrl,
  platform,
  children,
}: {
  user: ShellUser;
  organization: ShellOrg;
  role: 'admin' | 'recruiter' | 'interviewer';
  organizations: { organizationId: string; organizationName: string; role: string }[];
  appUrl: string;
  /** Set for platform admins (the people running this deployment). */
  platform?: { pendingSignups: number } | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [resending, setResending] = useState(false);

  useEffect(() => setMobileOpen(false), [pathname]);

  async function signOut() {
    try {
      await api('/api/auth/logout', { method: 'POST', body: {} });
    } finally {
      router.push('/login');
      router.refresh();
    }
  }

  async function switchOrg(id: string) {
    try {
      await api('/api/auth/switch-organization', { body: { organizationId: id } });
      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const sidebar = (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex h-16 shrink-0 items-center justify-between px-5">
        <Link href="/dashboard" aria-label="Calendor home">
          <Logo tone="light" />
        </Link>
        <button className="rounded-lg p-1.5 text-sidebar-muted hover:bg-white/10 lg:hidden" onClick={() => setMobileOpen(false)} aria-label="Close menu">
          <X className="size-5" />
        </button>
      </div>

      {organizations.length > 1 ? (
        <div className="px-3 pb-2">
          <Dropdown>
            <DropdownTrigger className="flex w-full items-center justify-between rounded-lg border border-white/10 px-3 py-2 text-left text-sm text-white hover:bg-white/5">
              <span className="truncate font-medium">{organization.name}</span>
              <ChevronsUpDown className="size-4 text-sidebar-muted" />
            </DropdownTrigger>
            <DropdownContent align="start" className="w-60">
              <DropdownLabel>Switch organization</DropdownLabel>
              {organizations.map((o) => (
                <DropdownItem key={o.organizationId} onSelect={() => o.organizationId !== organization.id && switchOrg(o.organizationId)}>
                  <span className="flex-1 truncate">{o.organizationName}</span>
                  {o.organizationId === organization.id && <Check className="!text-brand-600" />}
                </DropdownItem>
              ))}
            </DropdownContent>
          </Dropdown>
        </div>
      ) : (
        <div className="px-5 pb-2 text-xs font-medium text-sidebar-muted/80">{organization.name}</div>
      )}

      <nav className="scrollbar-thin flex-1 overflow-y-auto px-3 pb-4" aria-label="Main">
        <NavGroup items={MAIN} pathname={pathname} />
        <NavGroup title="Setup" items={SETUP} pathname={pathname} />
        <NavGroup title="Organization" items={ORG} pathname={pathname} />
        {role === 'admin' && <NavGroup title="Admin" items={ADMIN} pathname={pathname} />}
        {platform && (
          <NavGroup title="Platform" items={[{ href: '/platform/signups', label: 'Sign-up requests', icon: UserCheck, count: platform.pendingSignups }]} pathname={pathname} />
        )}
      </nav>

      <div className="border-t border-white/[0.07] p-3">
        <Dropdown>
          <DropdownTrigger className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-white/5">
            <Avatar name={user.name} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-white">{user.name}</span>
              <span className="block truncate text-xs capitalize text-sidebar-muted">{role}</span>
            </span>
            <ChevronsUpDown className="size-4 text-sidebar-muted" />
          </DropdownTrigger>
          <DropdownContent align="start" className="w-64">
            <DropdownLabel>{user.email}</DropdownLabel>
            <DropdownItem asChild>
              <Link href="/settings">
                <Settings /> Profile & settings
              </Link>
            </DropdownItem>
            <DropdownItem asChild>
              <a href={`${appUrl}/schedule/${user.username}`} target="_blank" rel="noreferrer">
                <ExternalLink /> View my booking page
              </a>
            </DropdownItem>
            <DropdownSeparator />
            <DropdownItem onSelect={signOut}>
              <LogOut /> Sign out
            </DropdownItem>
          </DropdownContent>
        </Dropdown>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 lg:block">{sidebar}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-zinc-950/50" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 animate-slide-in">{sidebar}</aside>
        </div>
      )}
      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-zinc-200 bg-white/90 px-4 backdrop-blur lg:hidden">
          <button className="rounded-lg p-1.5 text-zinc-600 hover:bg-zinc-100" onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <Logo />
        </header>
        {!user.emailVerified && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-center text-sm text-amber-900 lg:px-8">
            Verify your email address to publish your booking pages.{' '}
            <button
              className="font-semibold underline underline-offset-2 disabled:opacity-50"
              disabled={resending}
              onClick={async () => {
                setResending(true);
                try {
                  await api('/api/auth/resend-verification', { body: {} });
                  toast.success(`Verification email sent to ${user.email}`);
                } catch (err) {
                  toast.error(errorMessage(err));
                } finally {
                  setResending(false);
                }
              }}
            >
              Resend verification email
            </button>
          </div>
        )}
        <main className="mx-auto w-full max-w-[1320px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
