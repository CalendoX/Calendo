/**
 * Browser-side JSON client for the Calendor REST API. Errors are normalised into ApiError so forms
 * can show field-level messages (`error.fieldErrors`).
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get fieldErrors(): Record<string, string> {
    if (!this.details || typeof this.details !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.details as Record<string, unknown>)) {
      if (Array.isArray(v) && typeof v[0] === 'string') out[k] = v[0];
    }
    return out;
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export async function api<T = unknown>(path: string, opts: { method?: Method; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<T> {
  // FormData (file uploads) is sent as-is so the browser sets the multipart boundary.
  const isForm = opts.body instanceof FormData;
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: {
      Accept: 'application/json',
      ...(opts.body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
    body: isForm ? (opts.body as FormData) : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
    cache: 'no-store',
    signal: opts.signal,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'HTTP_ERROR',
      err?.message ?? (res.status === 429 ? 'Too many requests. Please wait a moment.' : 'Something went wrong. Please try again.'),
      err?.details,
    );
  }
  return data as T;
}

export function errorMessage(err: unknown, fallback = 'Something went wrong. Please try again.') {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.name === 'AbortError') return fallback;
  return fallback;
}
