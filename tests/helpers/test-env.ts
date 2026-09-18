/**
 * Environment for the integration suite. Applied in the global setup (migrations) and in every
 * test worker before any server module reads configuration.
 *
 * Integration tests run against a real Postgres database (default: the `slate_test` database
 * created by docker/postgres/init). Override with TEST_DATABASE_URL.
 */

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://slate:slate@localhost:5432/slate_test';

export const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:3000',
  // https so Google push-notification channels are registered (served by the fake provider).
  WEBHOOK_BASE_URL: 'https://hooks.slate.test',
  DATABASE_URL: TEST_DATABASE_URL,
  DATABASE_POOL_MAX: '8',
  SESSION_SECRET: 'integration-test-session-secret-0123456789abcdef',
  ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64'),
  GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/integrations/google/callback',
  ZOOM_CLIENT_ID: 'test-zoom-client-id',
  ZOOM_CLIENT_SECRET: 'test-zoom-client-secret',
  ZOOM_REDIRECT_URI: 'http://localhost:3000/api/integrations/zoom/callback',
  ZOOM_WEBHOOK_SECRET_TOKEN: 'test-zoom-webhook-secret',
  EMAIL_PROVIDER: 'console',
  EMAIL_FROM: 'Slate Test <scheduling@slate.test>',
  LOG_LEVEL: 'error',
};

export function applyTestEnv() {
  for (const [key, value] of Object.entries(TEST_ENV)) process.env[key] = value;
  for (const key of ['ENCRYPTION_KEY_PREVIOUS', 'CORS_ALLOWED_ORIGINS', 'TRUST_PROXY', 'SMTP_HOST', 'RESEND_API_KEY']) {
    delete process.env[key];
  }
}

/** Refuses to run destructive setup against anything that is not clearly a test database. */
export function assertTestDatabase(url: string) {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to run integration tests against database "${name}" — its name must end with "_test".`);
  }
  return name;
}
