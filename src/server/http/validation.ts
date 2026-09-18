import { z } from 'zod';
import { BadRequestError, ValidationError } from './errors';

export function formatZodError(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.join('.') : '_';
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

export function parseWith<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError('Please correct the highlighted fields.', formatZodError(result.error));
  }
  return result.data;
}

const MAX_JSON_BYTES = 256 * 1024;

export async function parseJsonBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new BadRequestError('Expected application/json request body', 'UNSUPPORTED_MEDIA_TYPE');
  }
  const text = await req.text();
  if (text.length > MAX_JSON_BYTES) throw new BadRequestError('Request body too large', 'PAYLOAD_TOO_LARGE');
  let data: unknown;
  try {
    data = text.length ? JSON.parse(text) : {};
  } catch {
    throw new BadRequestError('Malformed JSON body', 'INVALID_JSON');
  }
  return parseWith(schema, data);
}

export function parseSearchParams<T extends z.ZodType>(url: string | URL, schema: T): z.infer<T> {
  const params = new URL(url).searchParams;
  const obj: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    obj[key] = all.length > 1 ? all : all[0];
  }
  return parseWith(schema, obj);
}

// Shared field schemas ---------------------------------------------------------------------

export const zEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ message: 'Enter a valid email address' }));

export const zName = z.string().trim().min(1, 'Required').max(120);

export const zTimeZone = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown time zone');

export const zHttpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'Enter a valid http(s) URL');

export const zUuid = z.uuid();

export const zIsoInstant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
