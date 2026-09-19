import { z } from 'zod';

/**
 * Centralised, validated runtime configuration.
 *
 * Parsed lazily (on first access) so that `next build` can import server modules
 * without every secret being present at build time. Any misconfiguration fails
 * loudly the first time the value is actually needed.
 */

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.url().default('http://localhost:9000'),
  APP_NAME: z.string().default('Calendor'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_SSL: booleanish.default(false),

  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY must be 32 bytes, base64 encoded'),
  /** Comma-separated list of previous keys (base64) still accepted for decryption during rotation. */
  ENCRYPTION_KEY_PREVIOUS: optionalString,

  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_REDIRECT_URI: optionalString,

  ZOOM_CLIENT_ID: optionalString,
  ZOOM_CLIENT_SECRET: optionalString,
  ZOOM_REDIRECT_URI: optionalString,
  ZOOM_WEBHOOK_SECRET_TOKEN: optionalString,

  /** Public HTTPS base URL used for provider push notifications (defaults to APP_URL). */
  WEBHOOK_BASE_URL: optionalString,

  EMAIL_PROVIDER: z.enum(['smtp', 'resend', 'console']).default('console'),
  EMAIL_FROM: z.string().default('Calendor <no-reply@localhost>'),
  EMAIL_REPLY_TO: optionalString,
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  SMTP_SECURE: booleanish.default(false),
  RESEND_API_KEY: optionalString,

  CORS_ALLOWED_ORIGINS: optionalString,
  TRUST_PROXY: booleanish.default(false),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  if (parsed.data.EMAIL_PROVIDER === 'smtp' && !parsed.data.SMTP_HOST) {
    throw new Error('Invalid environment configuration: SMTP_HOST is required when EMAIL_PROVIDER=smtp');
  }
  if (parsed.data.EMAIL_PROVIDER === 'resend' && !parsed.data.RESEND_API_KEY) {
    throw new Error('Invalid environment configuration: RESEND_API_KEY is required when EMAIL_PROVIDER=resend');
  }
  cached = parsed.data;
  return cached;
}

/** For tests only: force re-reading process.env. */
export function resetEnvCache() {
  cached = null;
}

export function appUrl(path = ''): string {
  const base = env().APP_URL.replace(/\/$/, '');
  return path ? `${base}${path.startsWith('/') ? path : `/${path}`}` : base;
}

export function isProduction() {
  return env().NODE_ENV === 'production';
}

export function googleConfig() {
  const e = env();
  if (!e.GOOGLE_CLIENT_ID || !e.GOOGLE_CLIENT_SECRET) return null;
  return {
    clientId: e.GOOGLE_CLIENT_ID,
    clientSecret: e.GOOGLE_CLIENT_SECRET,
    redirectUri: e.GOOGLE_REDIRECT_URI ?? appUrl('/api/integrations/google/callback'),
  };
}

export function zoomConfig() {
  const e = env();
  if (!e.ZOOM_CLIENT_ID || !e.ZOOM_CLIENT_SECRET) return null;
  return {
    clientId: e.ZOOM_CLIENT_ID,
    clientSecret: e.ZOOM_CLIENT_SECRET,
    redirectUri: e.ZOOM_REDIRECT_URI ?? appUrl('/api/integrations/zoom/callback'),
    webhookSecretToken: e.ZOOM_WEBHOOK_SECRET_TOKEN,
  };
}

export function webhookBaseUrl(): string {
  return (env().WEBHOOK_BASE_URL ?? env().APP_URL).replace(/\/$/, '');
}
