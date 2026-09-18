import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { RateLimitError } from '../http/errors';

/**
 * Fixed-window rate limiter backed by Postgres, so limits hold across every app instance
 * without extra infrastructure. Each call is a single atomic upsert.
 */

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfterSeconds: number;
}

export async function hitRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const windowMs = windowSeconds * 1000;
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
  const expiresAt = new Date(windowStart.getTime() + windowMs);
  const result = await db.execute<{ count: number }>(sql`
    INSERT INTO rate_limits (key, window_start, count, expires_at)
    VALUES (${key}, ${windowStart.toISOString()}, 1, ${expiresAt.toISOString()})
    ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
    RETURNING count
  `);
  const count = Number(result.rows[0]?.count ?? 1);
  return {
    allowed: count <= limit,
    count,
    limit,
    retryAfterSeconds: Math.max(1, Math.ceil((expiresAt.getTime() - now) / 1000)),
  };
}

export async function enforceRateLimit(key: string, limit: number, windowSeconds: number) {
  const r = await hitRateLimit(key, limit, windowSeconds);
  if (!r.allowed) throw new RateLimitError(r.retryAfterSeconds);
  return r;
}

/** Central catalogue of limits so they are easy to audit and tune. */
export const LIMITS = {
  loginPerIp: { limit: 30, window: 600 },
  loginPerEmail: { limit: 10, window: 900 },
  signupPerIp: { limit: 5, window: 3600 },
  passwordResetPerIp: { limit: 10, window: 3600 },
  passwordResetPerEmail: { limit: 3, window: 3600 },
  verificationResendPerUser: { limit: 5, window: 3600 },
  publicPagePerIp: { limit: 240, window: 60 },
  publicAvailabilityPerIp: { limit: 120, window: 60 },
  publicBookingPerIp: { limit: 10, window: 600 },
  publicBookingPerEmail: { limit: 5, window: 3600 },
  bookingManagePerIp: { limit: 30, window: 600 },
  webhookPerIp: { limit: 600, window: 60 },
  authenticatedMutationPerUser: { limit: 300, window: 60 },
} as const;
