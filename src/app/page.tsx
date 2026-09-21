import { ArrowRight, CalendarCheck2, Clock3, Globe2, ShieldCheck, Video, Zap } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Logo } from '@/components/app/logo';
import { Button } from '@/components/ui/button';
import { PLANS } from '@/lib/plans';
import { getAuth } from '@/server/auth/session';

export default async function HomePage() {
  if (await getAuth()) redirect('/dashboard');
  const features = [
    { icon: CalendarCheck2, title: 'Real availability', body: 'Working hours, buffers, notice and every connected calendar — computed on the server, never guessed.' },
    { icon: Video, title: 'Zoom, automatically', body: 'A meeting for every interview, updated when it moves and removed when it’s cancelled.' },
    { icon: Globe2, title: 'Time-zone correct', body: 'Candidates see their local time; daylight-saving changes are handled for you.' },
    { icon: Zap, title: 'No double-booking', body: 'Per-interviewer locking and database constraints make overlapping bookings impossible.' },
    { icon: Clock3, title: 'Reminders that land', body: 'Confirmations, reschedules and reminders sent reliably from a background queue.' },
    { icon: ShieldCheck, title: 'Built for teams', body: 'Roles, tenant isolation, audit logs and an admin console for your hiring operations.' },
  ];
  return (
    <div className="min-h-screen bg-white">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Logo />
        <nav className="flex items-center gap-2">
          <Button asChild variant="ghost">
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
      <main>
        <section className="mx-auto max-w-4xl px-6 pb-20 pt-16 text-center sm:pt-24">
          <p className="mb-5 inline-flex items-center gap-2 rounded-full bg-brand-50 px-3 py-1 text-sm font-medium text-brand-800 ring-1 ring-brand-200">Interview scheduling for hiring teams</p>
          <h1 className="text-4xl font-semibold tracking-tight text-zinc-900 sm:text-6xl">Book interviews without the back-and-forth.</h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-zinc-600">
            Share one link. Candidates pick a time that actually works for your interviewers, and Calendo handles the Zoom meeting, the calendar event and every follow-up email.
          </p>
          <div className="mt-10 flex flex-wrap justify-center gap-3">
            <Button asChild size="lg">
              <Link href="/signup">
                Create your team <ArrowRight />
              </Link>
            </Button>
            <Button asChild size="lg" variant="secondary">
              <Link href="/login">Sign in</Link>
            </Button>
          </div>
        </section>
        <section className="border-t border-zinc-100 bg-canvas">
          <div className="mx-auto grid max-w-6xl gap-6 px-6 py-20 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f) => (
              <div key={f.title} className="rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-card">
                <span className="flex size-10 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
                  <f.icon className="size-5" />
                </span>
                <h2 className="mt-4 text-base font-semibold text-zinc-900">{f.title}</h2>
                <p className="mt-1.5 text-sm leading-relaxed text-zinc-600">{f.body}</p>
              </div>
            ))}
          </div>
        </section>
        <section className="border-t border-zinc-100">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <div className="text-center">
              <h2 className="text-3xl font-semibold tracking-tight text-zinc-900">Free to start, priced to grow</h2>
              <p className="mx-auto mt-4 max-w-2xl text-zinc-600">
                Everything above is on the Free plan. Premium and Custom are for teams that outgrow it.
              </p>
            </div>
            <div className="mt-10 grid gap-4 sm:grid-cols-3">
              {PLANS.map((plan) => (
                <Link
                  key={plan.id}
                  href="/pricing"
                  className="rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-card transition-colors hover:border-brand-300"
                >
                  <h3 className="text-base font-semibold text-zinc-900">{plan.name}</h3>
                  <p className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900">{plan.price}</p>
                  <p className="mt-1 text-xs text-zinc-500">{plan.priceNote}</p>
                  <p className="mt-3 text-sm leading-relaxed text-zinc-600">{plan.tagline}</p>
                </Link>
              ))}
            </div>
            <div className="mt-8 text-center">
              <Button asChild size="lg" variant="secondary">
                <Link href="/pricing">
                  Compare plans <ArrowRight />
                </Link>
              </Button>
            </div>
          </div>
        </section>
      </main>
      <footer className="border-t border-zinc-100 py-8 text-center text-sm text-zinc-500">
        <Link href="/pricing" className="hover:text-zinc-700">
          Pricing
        </Link>{' '}
        ·{' '}
        <a href="https://github.com/CalendoX/Calendo" target="_blank" rel="noopener noreferrer" className="hover:text-zinc-700">
          Open source on GitHub
        </a>{' '}
        · © {new Date().getFullYear()} Calendo
      </footer>
    </div>
  );
}
