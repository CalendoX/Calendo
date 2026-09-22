import { ArrowRight, CalendarCheck2, Clock3, Globe2, ShieldCheck, Video, Zap } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { GitHubIcon, GITHUB_REPO_URL } from '@/components/app/github-icon';
import { Logo } from '@/components/app/logo';
import { Button } from '@/components/ui/button';
import { getAuth } from '@/server/auth/session';

const FEATURES = [
  { icon: CalendarCheck2, title: 'Real availability', body: 'Working hours, buffers and every connected calendar, checked live.' },
  { icon: Video, title: 'Zoom, automatically', body: 'A meeting for every interview, kept in sync when plans change.' },
  { icon: Globe2, title: 'Time-zone correct', body: 'Candidates see their own local time, daylight saving included.' },
  { icon: Zap, title: 'No double-booking', body: 'Overlapping bookings are blocked, even when two people click at once.' },
  { icon: Clock3, title: 'Reminders that land', body: 'Confirmations, reschedules and reminders, sent for you.' },
  { icon: ShieldCheck, title: 'Built for teams', body: 'Roles, audit logs and an admin console for hiring operations.' },
];

export default async function HomePage() {
  if (await getAuth()) redirect('/dashboard');
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <Logo />
        <nav className="flex items-center gap-1 sm:gap-2">
          <Button asChild variant="ghost" className="hidden sm:inline-flex">
            <Link href="/pricing">Pricing</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link href="/login">Sign in</Link>
          </Button>
          <Button asChild>
            <Link href="/signup">Get started</Link>
          </Button>
        </nav>
      </header>

      <main className="flex-1">
        <section className="mx-auto max-w-3xl px-4 pb-20 pt-14 text-center sm:px-6 sm:pb-28 sm:pt-24">
          <p className="mb-5 inline-flex items-center rounded-full bg-brand-50 px-3 py-1 text-sm font-medium text-brand-800 ring-1 ring-brand-200">Interview scheduling for hiring teams</p>
          <h1 className="text-balance text-4xl font-semibold tracking-tight text-zinc-900 sm:text-6xl">Book interviews without the back-and-forth.</h1>
          <p className="mx-auto mt-6 max-w-xl text-pretty text-lg leading-relaxed text-zinc-600">
            Share one link. Candidates pick a time that works, and Calendo handles the Zoom meeting, the calendar event and every <span className="whitespace-nowrap">follow-up email</span>.
          </p>
          <div className="mt-10 flex flex-wrap justify-center gap-3">
            <Button asChild size="lg">
              <Link href="/signup">
                Create your team <ArrowRight />
              </Link>
            </Button>
            <Button asChild size="lg" variant="secondary">
              <a href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer">
                <GitHubIcon /> View on GitHub
              </a>
            </Button>
          </div>
        </section>

        <section className="mx-auto grid max-w-6xl gap-x-10 gap-y-9 px-4 pb-20 sm:grid-cols-2 sm:px-6 sm:pb-28 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="flex gap-4">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
                <f.icon className="size-[18px]" />
              </span>
              <div>
                <h2 className="text-[15px] font-semibold text-zinc-900">{f.title}</h2>
                <p className="mt-1 text-sm leading-relaxed text-zinc-600">{f.body}</p>
              </div>
            </div>
          ))}
        </section>

        <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6 sm:pb-28">
          <div className="rounded-3xl bg-canvas px-6 py-12 text-center sm:py-16">
            <h2 className="text-2xl font-semibold tracking-tight text-zinc-900 sm:text-3xl">Free for your whole team</h2>
            <p className="mx-auto mt-3 max-w-md text-pretty text-zinc-600">Everything above is included. Premium and Custom plans are for teams that outgrow it.</p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Button asChild size="lg">
                <Link href="/signup">
                  Get started <ArrowRight />
                </Link>
              </Button>
              <Button asChild size="lg" variant="secondary">
                <Link href="/pricing">Compare plans</Link>
              </Button>
            </div>
          </div>
        </section>
      </main>

      <footer className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <div className="flex flex-col items-center justify-between gap-3 border-t border-zinc-100 py-8 text-sm text-zinc-500 sm:flex-row">
          <p>© {new Date().getFullYear()} CalendoX</p>
          <nav className="flex items-center gap-6">
            <Link href="/pricing" className="hover:text-zinc-900">
              Pricing
            </Link>
            <a href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 hover:text-zinc-900">
              <GitHubIcon /> Open source on GitHub
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
