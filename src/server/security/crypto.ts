import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';

/**
 * Cryptographic helpers.
 *
 * - Capability tokens (sessions, password resets, booking links, OAuth state) are 256-bit random
 *   values. Only an HMAC-SHA256 (keyed with SESSION_SECRET) is stored, so a database leak alone
 *   does not reveal usable tokens.
 * - Secrets we must be able to read back (OAuth refresh tokens, Zoom host URLs) are encrypted
 *   with AES-256-GCM using ENCRYPTION_KEY. Ciphertexts are versioned for key rotation.
 */

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHmac('sha256', env().SESSION_SECRET).update(token).digest('hex');
}

export function sha256Base64Url(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

export function hmacSha256Hex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const CIPHER_VERSION = 'v1';

function keys(): Buffer[] {
  const e = env();
  const current = Buffer.from(e.ENCRYPTION_KEY, 'base64');
  const previous = (e.ENCRYPTION_KEY_PREVIOUS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => Buffer.from(k, 'base64'))
    .filter((k) => k.length === 32);
  return [current, ...previous];
}

export function encrypt(plaintext: string): string {
  const [key] = keys();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [CIPHER_VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
}

export function decrypt(payload: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(':');
  if (version !== CIPHER_VERSION || !ivB64 || !tagB64 || dataB64 === undefined) {
    throw new Error('Unsupported ciphertext format');
  }
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const data = Buffer.from(dataB64, 'base64url');
  let lastError: unknown;
  for (const key of keys()) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Unable to decrypt value: ${(lastError as Error)?.message ?? 'unknown error'}`);
}

export function encryptNullable(value: string | null | undefined): string | null {
  return value ? encrypt(value) : null;
}

export function decryptNullable(value: string | null | undefined): string | null {
  return value ? decrypt(value) : null;
}

/** PKCE (RFC 7636) S256 code challenge for a verifier. */
export function pkceChallenge(verifier: string): string {
  return sha256Base64Url(verifier);
}
