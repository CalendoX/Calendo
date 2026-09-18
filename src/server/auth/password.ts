import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing with Argon2id (library defaults follow OWASP guidance:
 * m=19 MiB, t=2, p=1).
 */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export async function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** A precomputed hash used to equalise timing when the account does not exist. */
let dummyHash: Promise<string> | null = null;
export async function burnPasswordCheck(password: string) {
  dummyHash ??= hash('timing-equaliser-not-a-real-password');
  await verifyPassword(await dummyHash, password);
}

export function passwordPolicyError(password: string, context: { email?: string; name?: string } = {}): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
  const lower = password.toLowerCase();
  if (context.email && lower.includes(context.email.split('@')[0].toLowerCase()) && context.email.split('@')[0].length >= 4) {
    return 'Password must not contain your email address.';
  }
  if (/^(.)\1+$/.test(password)) return 'Password is too predictable.';
  const common = ['password', '1234567890', 'qwertyuiop', 'letmein123', 'welcome123'];
  if (common.some((c) => lower.includes(c))) return 'Password is too common.';
  return null;
}
