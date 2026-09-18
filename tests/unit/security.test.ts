import { describe, expect, it } from 'vitest';
import { passwordPolicyError } from '@/server/auth/password';
import { resetEnvCache } from '@/server/config/env';
import { decrypt, encrypt, hashToken, pkceChallenge, randomToken, safeEqual } from '@/server/security/crypto';
import { verifyZoomSignature, zoomUrlValidationResponse } from '@/server/integrations/zoom/webhooks';
import { hmacSha256Hex } from '@/server/security/crypto';

describe('crypto', () => {
  it('generates 256-bit URL-safe random tokens', () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(Array.from({ length: 100 }, () => randomToken())).size).toBe(100);
  });

  it('hashes tokens with a keyed HMAC (stable, but not a plain SHA-256)', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
    expect(hashToken('abc')).not.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('encrypts with AES-GCM: random IVs, round-trips, and detects tampering', () => {
    const secret = 'ya29.refresh-token-value';
    const a = encrypt(secret);
    const b = encrypt(secret);
    expect(a).not.toBe(b);
    expect(a.startsWith('v1:')).toBe(true);
    expect(a).not.toContain(secret);
    expect(decrypt(a)).toBe(secret);

    const [v, iv, tag, data] = a.split(':');
    const flipped = data.slice(0, -2) + (data.at(-2) === 'A' ? 'B' : 'A') + data.at(-1);
    expect(() => decrypt([v, iv, tag, flipped].join(':'))).toThrow(/Unable to decrypt/);
    expect(() => decrypt('plaintext')).toThrow(/Unsupported ciphertext/);
  });

  it('keeps decrypting old ciphertexts during key rotation', () => {
    const oldKey = process.env.ENCRYPTION_KEY!;
    const legacy = encrypt('stored before rotation');
    try {
      process.env.ENCRYPTION_KEY = Buffer.alloc(32, 99).toString('base64');
      process.env.ENCRYPTION_KEY_PREVIOUS = oldKey;
      resetEnvCache();
      expect(decrypt(legacy)).toBe('stored before rotation');
      const fresh = encrypt('new');
      delete process.env.ENCRYPTION_KEY_PREVIOUS;
      resetEnvCache();
      expect(decrypt(fresh)).toBe('new');
      expect(() => decrypt(legacy)).toThrow();
    } finally {
      process.env.ENCRYPTION_KEY = oldKey;
      delete process.env.ENCRYPTION_KEY_PREVIOUS;
      resetEnvCache();
    }
  });

  it('computes PKCE S256 challenges as BASE64URL(SHA256(verifier)) without padding (RFC 7636 §4.2)', async () => {
    const verifier = randomToken(48);
    // Independent implementation: WebCrypto digest + manual base64url.
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const expected = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(pkceChallenge(verifier)).toBe(expected);
    expect(pkceChallenge(verifier)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Verifiers we generate satisfy the spec's 43–128 unreserved-character rule.
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
  });

  it('compares secrets in constant time and handles length mismatches', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('Zoom webhook signatures', () => {
  const secret = 'zoom-secret';
  const body = '{"event":"meeting.deleted","payload":{"object":{"id":1}}}';
  const now = 1_790_000_000_000;
  const ts = String(now / 1000);
  const signature = `v0=${hmacSha256Hex(secret, `v0:${ts}:${body}`)}`;

  it('accepts a correctly signed, fresh request', () => {
    expect(verifyZoomSignature({ rawBody: body, timestamp: ts, signature, secret, now })).toBe(true);
  });

  it('rejects tampered bodies, wrong secrets, missing headers and stale timestamps', () => {
    expect(verifyZoomSignature({ rawBody: body.replace('1', '2'), timestamp: ts, signature, secret, now })).toBe(false);
    expect(verifyZoomSignature({ rawBody: body, timestamp: ts, signature, secret: 'other', now })).toBe(false);
    expect(verifyZoomSignature({ rawBody: body, timestamp: null, signature, secret, now })).toBe(false);
    expect(verifyZoomSignature({ rawBody: body, timestamp: ts, signature: null, secret, now })).toBe(false);
    expect(verifyZoomSignature({ rawBody: body, timestamp: ts, signature, secret, now: now + 6 * 60_000 })).toBe(false);
    expect(verifyZoomSignature({ rawBody: body, timestamp: 'not-a-number', signature, secret, now })).toBe(false);
  });

  it('answers the URL validation challenge with an HMAC of the plain token', () => {
    expect(zoomUrlValidationResponse('abc', secret)).toEqual({ plainToken: 'abc', encryptedToken: hmacSha256Hex(secret, 'abc') });
  });
});

describe('password policy', () => {
  it('enforces length, and rejects predictable or personal passwords', () => {
    expect(passwordPolicyError('short')).toMatch(/at least 10/);
    expect(passwordPolicyError('x'.repeat(129))).toMatch(/at most/);
    expect(passwordPolicyError('aaaaaaaaaaaa')).toMatch(/predictable/);
    expect(passwordPolicyError('MyPassword2026!')).toMatch(/common/);
    expect(passwordPolicyError('jordan-rivera-2026', { email: 'jordan@northwind.test' })).toMatch(/email/);
    expect(passwordPolicyError('Correct-Horse-Battery-9', { email: 'jordan@northwind.test' })).toBeNull();
  });
});
