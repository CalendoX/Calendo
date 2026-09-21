import { ArrowRight, Check } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Logo } from '@/components/app/logo';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PLANS, type Plan } from '@/lib/plans';
import { getAuth } from '@/server/auth/session';
import { contactEmail } from '@/server/config/env';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'Calendo pricing: Free, Premium and Custom plans for hiring teams.',
};

export default async function PricingPage() {
  const auth = await getAuth();
  const currentPlan = auth?.organization.plan ?? null;
  const contact = contactEmail();
  return (
    <div className="min-h-screen bg-white">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/" aria-label="Calendo home">
          <Logo />
        </Link>
        <nav className="flex items-center gap-2">
          {auth ? (
            <Button asChild>
              <Link href="/dashboard">Go to dashboard</Link>
            </Button>
          ) : (
            <>
              <Button asChild variant="ghost">
                <Link href="/login">Sign in</Link>
              </Button>
              <Button asChild>
                <Link href="/signup">Get started</Link>
              </Button>
            </>
          )}
        </nav>
      </header>
      <main>
        <section className="mx-auto max-w-3xl px-6 pb-14 pt-12 text-center sm:pt-20">
          <h1 className="text-4xl font-semibold tracking-tight text-zinc-900 sm:text-5xl">Pricing that starts at nothing.</h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-zinc-600">
            Every account starts on Free — the whole product, for your whole hiring team. Premium and Custom are on the way; nothing you rely on today moves
            behind them.
          </p>
        </section>
        <section className="mx-auto max-w-6xl px-6 pb-20">
          <div className="grid items-start gap-6 lg:grid-cols-3">
            {PLANS.map((plan) => (
              <PlanCard key={plan.id} plan={plan} current={plan.id === currentPlan} signedIn={Boolean(auth)} contact={contact} />
            ))}
          </div>
          <p className="mt-10 text-center text-sm text-zinc-500">
            Questions about a plan? Email{' '}
            <a href={`mailto:${contact}`} className="font-medium text-brand-700 hover:underline">
              {contact}
            </a>
            .
          </p>
        </section>
      </main>
      <footer className="border-t border-zinc-100 py-8 text-center text-sm text-zinc-500">
        <Link href="/" className="hover:text-zinc-700">
          © {new Date().getFullYear()} Calendo
        </Link>
      </footer>
    </div>
  );
}

function PlanCard({ plan, current, signedIn, contact }: { plan: Plan; current: boolean; signedIn: boolean; contact: string }) {
  return (
    <div
      className={
        plan.available
          ? 'flex h-full flex-col rounded-2xl border border-brand-200 bg-white p-7 shadow-card ring-1 ring-brand-500/20'
          : 'flex h-full flex-col rounded-2xl border border-zinc-200/80 bg-canvas p-7'
      }
    >
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold text-zinc-900">{plan.name}</h2>
        {current ? <Badge tone="brand">Your plan</Badge> : !plan.available && <Badge tone="amber">In development</Badge>}
      </div>
      <p className="mt-4 text-3xl font-semibold tracking-tight text-zinc-900">{plan.price}</p>
      <p className="mt-1 text-sm text-zinc-500">{plan.priceNote}</p>
      <p className="mt-4 text-sm leading-relaxed text-zinc-600">{plan.tagline}</p>
      <ul className="mt-6 flex-1 space-y-2.5 text-sm text-zinc-700">
        {plan.features.map((feature) => (
          <li key={feature} className="flex gap-2.5">
            <Check className="mt-0.5 size-4 shrink-0 text-brand-600" aria-hidden="true" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
      <div className="mt-7">
        <PlanAction plan={plan} current={current} signedIn={signedIn} contact={contact} />
      </div>
    </div>
  );
}

/** Only Free can be signed up for; the other two say what to do instead of pretending to sell. */
function PlanAction({ plan, current, signedIn, contact }: { plan: Plan; current: boolean; signedIn: boolean; contact: string }) {
  if (plan.id === 'custom') {
    return (
      <Button asChild variant="secondary" className="w-full" size="lg">
        <a href={`mailto:${contact}?subject=${encodeURIComponent('Calendo Custom plan')}`}>Contact us</a>
      </Button>
    );
  }
  if (current) return <p className="text-center text-sm font-medium text-brand-700">You’re on this plan.</p>;
  if (plan.available) {
    return signedIn ? (
      <Button asChild className="w-full" size="lg">
        <Link href="/dashboard">Go to dashboard</Link>
      </Button>
    ) : (
      <Button asChild className="w-full" size="lg">
        <Link href="/signup">
          Get started free <ArrowRight />
        </Link>
      </Button>
    );
  }
  return <p className="text-center text-sm text-zinc-500">Start on Free — we’ll tell you when {plan.name} is ready.</p>;
}
