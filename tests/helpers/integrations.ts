import { and, eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { POST as connectRoute } from '@/app/api/integrations/[provider]/connect/route';
import { GET as callbackRoute } from '@/app/api/integrations/[provider]/callback/route';
import { db } from '../../src/server/db/client';
import { integrations } from '../../src/server/db/schema';
import { fakeProviders } from './fake-providers';
import { signIn, signOut, type Org, type User } from './fixtures';
import { call } from './http';

/**
 * Runs the real OAuth flow for `user`: POST /connect → provider consent (simulated by the fake)
 * → GET /callback. Leaves the user signed out afterwards.
 */
export async function connect(provider: 'google' | 'zoom', user: User, org?: Org, opts: { scopes?: string[] } = {}) {
  await signIn(user, org);
  const start = await call(connectRoute, { path: `/api/integrations/${provider}/connect`, params: { provider }, body: {} });
  expect(start.status).toBe(200);
  const grant = provider === 'google' ? fakeProviders.google.authorize(start.body.url, opts) : fakeProviders.zoom.authorize(start.body.url, opts);
  const callback = await call(callbackRoute, {
    path: `/api/integrations/${provider}/callback?code=${encodeURIComponent(grant.code)}&state=${encodeURIComponent(grant.state)}`,
    params: { provider },
  });
  signOut();
  return { authorizationUrl: new URL(start.body.url), callback, grant };
}

export async function integrationRow(userId: string, provider: 'google_calendar' | 'zoom') {
  const [row] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.userId, userId), eq(integrations.provider, provider)))
    .limit(1);
  return row ?? null;
}
