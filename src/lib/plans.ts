/**
 * Pricing plans, shared by the public pricing page, the app and (later) anything that gates a
 * paid feature. Pure data — safe to import anywhere.
 *
 * Every organization is on `free` today: it is the product as it stands. `premium` and `custom`
 * exist so the tier an organization is on is recorded (`organizations.plan`) before the paid
 * features land; gate one of those features with `planIncludes(org.plan, 'premium')`.
 */

export type PlanId = 'free' | 'premium' | 'custom';

/** Cheapest first. Each plan includes everything in the plans before it. */
export const PLAN_ORDER: PlanId[] = ['free', 'premium', 'custom'];

export const PLAN_LABELS: Record<PlanId, string> = {
  free: 'Free',
  premium: 'Premium',
  custom: 'Custom',
};

export interface Plan {
  id: PlanId;
  name: string;
  /** Headline price, or what stands in for one while the plan is not yet purchasable. */
  price: string;
  priceNote: string;
  tagline: string;
  features: string[];
  /** Plans nobody can buy yet say so rather than showing a payment call to action. */
  available: boolean;
}

export const PLANS: Plan[] = [
  {
    id: 'free',
    name: PLAN_LABELS.free,
    price: '$0',
    priceNote: 'for your whole team',
    tagline: 'Everything the platform does today, for every hiring team.',
    features: [
      'Unlimited event types, booking links and interviews',
      'Availability from your real Google Calendar, with buffers and notice',
      'Zoom meetings, calendar events and reminder emails created automatically',
      'Candidates book, reschedule and cancel without an account',
      'Your whole team, with admin, recruiter and interviewer roles',
      'Audit log, email templates and your own sending domain',
    ],
    available: true,
  },
  {
    id: 'premium',
    name: PLAN_LABELS.premium,
    price: 'Coming soon',
    priceNote: 'pricing to be announced',
    tagline: 'Everything in Free, plus the features we are building for growing teams.',
    features: [
      'Everything in Free',
      'The premium capabilities currently in development',
      'Tell us what your team needs and we will prioritise it',
    ],
    available: false,
  },
  {
    id: 'custom',
    name: PLAN_LABELS.custom,
    price: 'Let’s talk',
    priceNote: 'priced per organization',
    tagline: 'For large hiring teams that need terms of their own.',
    features: [
      'Everything in Premium',
      'Volume pricing for large hiring teams',
      'Custom terms, invoicing and security review',
      'A named contact for onboarding and support',
    ],
    available: false,
  },
];

export function planById(id: PlanId): Plan {
  return PLANS.find((p) => p.id === id) ?? PLANS[0];
}

/** Whether an organization on `current` has access to everything `required` includes. */
export function planIncludes(current: PlanId, required: PlanId): boolean {
  return PLAN_ORDER.indexOf(current) >= PLAN_ORDER.indexOf(required);
}
