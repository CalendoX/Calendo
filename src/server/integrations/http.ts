import type { IntegrationProvider } from '../db/schema';
import { IntegrationError, type AccessTokenSource } from './types';

/**
 * Minimal typed HTTP client shared by provider implementations: timeouts, JSON handling,
 * one automatic token refresh on 401, and classification of failures into IntegrationError
 * kinds that drive retry behaviour.
 */

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = (input, init) => fetch(input, init);

/** Test hook: route all provider HTTP traffic through a stub. */
export function setIntegrationFetch(impl: FetchLike | null) {
  fetchImpl = impl ?? ((input, init) => fetch(input, init));
}

export function integrationFetch(input: string | URL, init?: RequestInit) {
  return fetchImpl(input, init);
}

export interface ProviderRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  body?: unknown;
  form?: Record<string, string>;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface ProviderResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

export async function rawRequest(provider: IntegrationProvider, req: ProviderRequest): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json', ...req.headers };
  let body: BodyInit | undefined;
  if (req.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(req.form).toString();
  } else if (req.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(req.body);
  }
  try {
    return await integrationFetch(req.url, {
      method: req.method ?? 'GET',
      headers,
      body,
      signal: AbortSignal.timeout(req.timeoutMs ?? 15_000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new IntegrationError(provider, 'transient', `Network error contacting ${provider}: ${message}`);
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describe(body: unknown): string {
  if (!body) return '';
  if (typeof body === 'string') return body.slice(0, 300);
  if (typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const nested = b.error as Record<string, unknown> | string | undefined;
    if (typeof nested === 'string') return [nested, b.error_description].filter(Boolean).join(': ');
    if (nested && typeof nested === 'object' && typeof nested.message === 'string') return nested.message;
    if (typeof b.message === 'string') return b.message;
  }
  return JSON.stringify(body).slice(0, 300);
}

export function classifyFailure(
  provider: IntegrationProvider,
  status: number,
  body: unknown,
  headers: Headers,
  context: string,
): IntegrationError {
  const detail = describe(body);
  const message = `${context} failed (${status})${detail ? `: ${detail}` : ''}`;
  if (status === 401) return new IntegrationError(provider, 'auth', message, status);
  if (status === 404 || status === 410) return new IntegrationError(provider, 'not_found', message, status);
  if (status === 409) return new IntegrationError(provider, 'conflict', message, status);
  if (status === 429) {
    const retryAfter = Number(headers.get('retry-after')) || undefined;
    return new IntegrationError(provider, 'rate_limited', message, status, retryAfter);
  }
  if (status === 403) {
    // Google signals quota exhaustion with 403 + rateLimitExceeded / userRateLimitExceeded.
    const text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    if (/rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(text)) {
      return new IntegrationError(provider, 'rate_limited', message, status);
    }
    return new IntegrationError(provider, 'permanent', message, status);
  }
  if (status >= 500) return new IntegrationError(provider, 'transient', message, status);
  return new IntegrationError(provider, 'permanent', message, status);
}

/** Authenticated JSON request with a single refresh-and-retry on 401. */
export async function authedRequest<T>(
  provider: IntegrationProvider,
  token: AccessTokenSource,
  req: ProviderRequest,
  context: string,
): Promise<ProviderResponse<T>> {
  let accessToken = await token.get();
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await rawRequest(provider, {
      ...req,
      headers: { ...req.headers, Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 401 && attempt === 0) {
      await res.body?.cancel().catch(() => undefined);
      accessToken = await token.refresh();
      continue;
    }
    const data = await readBody(res);
    if (!res.ok) throw classifyFailure(provider, res.status, data, res.headers, context);
    return { status: res.status, data: data as T, headers: res.headers };
  }
  throw new IntegrationError(provider, 'auth', `${context} failed: access token rejected after refresh`, 401);
}

/** Unauthenticated/basic-auth request used for OAuth token endpoints. */
export async function oauthRequest<T>(
  provider: IntegrationProvider,
  req: ProviderRequest,
  context: string,
): Promise<T> {
  const res = await rawRequest(provider, req);
  const data = await readBody(res);
  if (!res.ok) {
    const err = classifyFailure(provider, res.status, data, res.headers, context);
    // invalid_grant = refresh token revoked/expired: the user must reconnect.
    const text = typeof data === 'string' ? data : JSON.stringify(data ?? {});
    if (res.status === 400 && /invalid_grant|invalid_token|Invalid Token/i.test(text)) {
      throw new IntegrationError(provider, 'auth', err.message, res.status);
    }
    throw err;
  }
  return data as T;
}
