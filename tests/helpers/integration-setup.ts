import { afterAll, afterEach, beforeEach, vi } from 'vitest';
import { applyTestEnv } from './test-env';

applyTestEnv();

vi.mock('next/headers', async () => {
  const { cookieJar } = await import('./cookie-jar');
  return {
    cookies: async () => cookieJar,
    headers: async () => new Headers(),
  };
});

const { cookieJar } = await import('./cookie-jar');
const { outbox } = await import('./outbox');
const { fakeProviders } = await import('./fake-providers');
const { setEmailProviderOverride } = await import('../../src/server/notifications/email-provider');
const { setIntegrationFetch } = await import('../../src/server/integrations/http');
const { invalidateBusyCache } = await import('../../src/server/integrations/service');
const { stopProducer } = await import('../../src/server/jobs/queue');
const { closeDb } = await import('../../src/server/db/client');
const { resetDatabase } = await import('./db');

setEmailProviderOverride(outbox);
// Every Google / Zoom HTTP call goes to the in-process fake — never to the real APIs.
setIntegrationFetch(fakeProviders.fetch);

beforeEach(async () => {
  await resetDatabase();
  cookieJar.clear();
  outbox.clear();
  fakeProviders.reset();
  invalidateBusyCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  setIntegrationFetch(null);
  setEmailProviderOverride(null);
  await stopProducer();
  await closeDb();
});
