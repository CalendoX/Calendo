import type { NextRequest } from 'next/server';
import { env } from '../config/env';

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export function clientIp(req: Request | NextRequest): string | null {
  if (env().TRUST_PROXY) {
    const forwarded = req.headers.get('x-forwarded-for');
    if (forwarded) return forwarded.split(',')[0].trim();
    const real = req.headers.get('x-real-ip');
    if (real) return real.trim();
  }
  // Without a trusted proxy we cannot read the socket address from the Fetch API request;
  // fall back to a stable placeholder so rate limiting still groups anonymous traffic.
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? '127.0.0.1';
}

export function requestMeta(req: Request | NextRequest): RequestMeta {
  return {
    ip: clientIp(req),
    userAgent: req.headers.get('user-agent')?.slice(0, 512) ?? null,
  };
}
