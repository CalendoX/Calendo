import { describe, expect, it } from 'vitest';
import { PLAN_LABELS, PLAN_ORDER, PLANS, planById, planIncludes } from '@/lib/plans';
import { organizationPlan } from '@/server/db/schema';

describe('pricing plans', () => {
  it('offers exactly the plans the database column allows, cheapest first', () => {
    expect(PLAN_ORDER).toEqual(['free', 'premium', 'custom']);
    expect([...organizationPlan.enumValues].sort()).toEqual([...PLAN_ORDER].sort());
    expect(PLANS.map((p) => p.id)).toEqual(PLAN_ORDER);
    expect(PLANS.map((p) => p.name)).toEqual(PLAN_ORDER.map((id) => PLAN_LABELS[id]));
  });

  it('only sells the plan that exists today', () => {
    expect(PLANS.filter((p) => p.available).map((p) => p.id)).toEqual(['free']);
    expect(planById('premium').price).toBe('Coming soon');
  });

  it('grants a plan everything the plans below it include', () => {
    expect(planIncludes('free', 'free')).toBe(true);
    expect(planIncludes('free', 'premium')).toBe(false);
    expect(planIncludes('premium', 'free')).toBe(true);
    expect(planIncludes('custom', 'premium')).toBe(true);
  });
});
