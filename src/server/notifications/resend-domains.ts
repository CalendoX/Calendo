import { env } from '../config/env';
import { integrationFetch } from '../integrations/http';

/**
 * Resend Domains API: registers each organisation's own sending domain, reports the DNS records
 * it must publish, and verifies them. Needs a Resend API key with full access (not sending-only).
 */

export const RESEND_API = 'https://api.resend.com';

export interface ResendDomain {
  id: string;
  name: string;
  status: string;
  records?: { record?: string; name: string; type: string; value: string; priority?: number; status?: string }[];
}

export class ResendApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ResendApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const key = env().RESEND_API_KEY;
  if (!key) throw new ResendApiError(0, 'RESEND_API_KEY is not set');
  let res: Response;
  try {
    res = await integrationFetch(`${RESEND_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new ResendApiError(0, `Could not reach Resend: ${(err as Error).message}`);
  }
  const data = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new ResendApiError(res.status, data.message ?? `Resend API error ${res.status}`);
  return data as T;
}

export const resendDomains = {
  create: (name: string) => request<ResendDomain>('POST', '/domains', { name }),
  get: (id: string) => request<ResendDomain>('GET', `/domains/${encodeURIComponent(id)}`),
  verify: (id: string) => request<unknown>('POST', `/domains/${encodeURIComponent(id)}/verify`),
  remove: (id: string) => request<unknown>('DELETE', `/domains/${encodeURIComponent(id)}`),
};
