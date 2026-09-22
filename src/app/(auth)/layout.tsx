import Link from 'next/link';
import { Logo } from '@/components/app/logo';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_minmax(0,560px)]">
      <div className="relative hidden overflow-hidden bg-sidebar lg:block">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(31,156,125,0.35),transparent_55%),radial-gradient(ellipse_at_bottom_right,rgba(125,211,185,0.12),transparent_50%)]" />
        <div className="relative flex h-full flex-col justify-between p-12">
          <Link href="/">
            <Logo tone="light" />
          </Link>
          <div className="max-w-lg">
            <p className="text-3xl font-semibold leading-tight tracking-tight text-white">
              Interviews scheduled in one step — with the calendar, the Zoom link and the reminders already taken care of.
            </p>
            <ul className="mt-8 space-y-3 text-[15px] text-sidebar-muted">
              <li className="flex gap-3"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand-300" />Availability that respects every interviewer’s real calendar</li>
              <li className="flex gap-3"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand-300" />Zoom meetings and calendar events created automatically</li>
              <li className="flex gap-3"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand-300" />Candidates book, reschedule and cancel without an account</li>
            </ul>
          </div>
          <p className="text-xs text-sidebar-muted/70">© {new Date().getFullYear()} CalendoX</p>
        </div>
      </div>
      <div className="flex flex-col bg-white">
        <div className="p-6 lg:hidden">
          <Link href="/">
            <Logo />
          </Link>
        </div>
        <div className="flex flex-1 items-center justify-center px-6 py-10 sm:px-12">
          <div className="w-full max-w-sm">{children}</div>
        </div>
      </div>
    </div>
  );
}
