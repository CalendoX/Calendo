import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getAuth, type AuthContext } from '../auth/session';
import { env } from '../config/env';
import { AppError, ForbiddenError, RateLimitError, UnauthorizedError } from './errors';
import { formatZodError } from './validation';

type RouteContext<P> = { params: Promise<P> };

/**
 * Wraps a route handler with consistent error handling. Handlers stay thin: validate input,
 * authorise, call a service, serialise.
 */
export function apiRoute<P extends Record<string, string> = Record<string, never>>(
  handler: (req: NextRequest, params: P) => Promise<Response>,
) {
  return async (req: NextRequest, context: RouteContext<P>) => {
    try {
      const params = (context?.params ? await context.params : {}) as P;
      return await handler(req, params);
    } catch (err) {
      return errorResponse(err, req);
    }
  };
}

export function errorResponse(err: unknown, req?: Request): Response {
  if (err instanceof AppError) {
    const headers: Record<string, string> = {};
    if (err instanceof RateLimitError) headers['Retry-After'] = String(err.retryAfterSeconds);
    return NextResponse.json(
      { error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } },
      { status: err.status, headers },
    );
  }
  if (err instanceof z.ZodError) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: formatZodError(err) } },
      { status: 422 },
    );
  }
  const errorId = crypto.randomUUID();
  console.error(`[api] unhandled error ${errorId} ${req?.method ?? ''} ${req ? new URL(req.url).pathname : ''}`, err);
  return NextResponse.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.', errorId } },
    { status: 500 },
  );
}

export function json<T>(data: T, init?: number | ResponseInit) {
  return NextResponse.json(data, typeof init === 'number' ? { status: init } : init);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie-authenticated mutations: the session cookie is SameSite=Lax, and
 * any browser-originated unsafe request must carry an Origin header matching the app origin.
 */
export function assertSameOrigin(req: Request) {
  if (SAFE_METHODS.has(req.method)) return;
  const appOrigin = new URL(env().APP_URL).origin;
  const origin = req.headers.get('origin');
  if (origin) {
    if (origin !== appOrigin) throw new ForbiddenError('Cross-origin request rejected');
    return;
  }
  const fetchSite = req.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new ForbiddenError('Cross-site request rejected');
  }
}

/** Authenticates the request (session cookie) and applies CSRF checks for mutations. */
export async function authenticate(req: Request): Promise<AuthContext> {
  assertSameOrigin(req);
  const auth = await getAuth();
  if (!auth) throw new UnauthorizedError();
  return auth;
}

/** CORS for the public (unauthenticated) scheduling API, restricted to an allow-list. */
export function withPublicCors(req: Request, res: Response): Response {
  const origin = req.headers.get('origin');
  const allowed = (env().CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (origin && allowed.includes(origin)) {
    res.headers.set('Access-Control-Allow-Origin', origin);
    res.headers.set('Vary', 'Origin');
    res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key');
    res.headers.set('Access-Control-Max-Age', '600');
  }
  return res;
}

export function noStore(res: Response): Response {
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
