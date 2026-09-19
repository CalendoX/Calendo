import { NextRequest } from 'next/server';

/**
 * Invokes a Next.js route handler in-process with a real Request object, the way the Next
 * server does, and returns the decoded response.
 */

type Handler<P> = (req: NextRequest, ctx: { params: Promise<P> }) => Promise<Response> | Response;

export interface CallOptions<P> {
  method?: string;
  path: string;
  params?: P;
  body?: unknown;
  headers?: Record<string, string>;
  /** Browser-originated same-origin request (default). Set false to omit Origin, or a string to spoof one. */
  origin?: boolean | string;
  ip?: string;
}

export interface CallResult<T = any> {
  status: number;
  body: T;
  headers: Headers;
  location: string | null;
}

export async function call<T = any, P extends Record<string, string> = Record<string, string>>(
  handler: Handler<P>,
  opts: CallOptions<P>,
): Promise<CallResult<T>> {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = { 'user-agent': 'vitest', ...opts.headers };
  if (opts.ip) headers['x-forwarded-for'] = opts.ip;
  if (opts.origin !== false && method !== 'GET') headers.origin = typeof opts.origin === 'string' ? opts.origin : 'http://localhost:3000';
  let body: string | FormData | undefined;
  if (opts.body instanceof FormData) {
    // multipart/form-data: the Request sets the content type (with boundary) itself.
    body = opts.body;
  } else if (opts.body !== undefined) {
    headers['content-type'] ??= 'application/json';
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }
  const req = new NextRequest(new URL(opts.path, 'http://localhost:3000'), { method, headers, body });
  const res = await handler(req, { params: Promise.resolve((opts.params ?? {}) as P) });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body (e.g. ICS)
  }
  return { status: res.status, body: parsed as T, headers: res.headers, location: res.headers.get('location') };
}
