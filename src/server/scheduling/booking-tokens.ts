import { and, eq, gt, isNull } from 'drizzle-orm';
import { appUrl } from '../config/env';
import { db, type Executor } from '../db/client';
import { bookingTokens } from '../db/schema';
import { decrypt, encrypt, hashToken, randomToken } from '../security/crypto';

/**
 * Candidate capability tokens. Each booking gets three independent 256-bit tokens:
 *   view       → /booking/:token            (confirmation & details; valid until 30 days after the interview)
 *   reschedule → /booking/reschedule/:token (valid until the interview starts)
 *   cancel     → /booking/cancel/:token     (valid until the interview starts)
 *
 * Only an HMAC of each token is used for lookup. An AES-GCM encrypted copy lets later emails
 * (reminders, updates) include the same links. Tokens are revoked on cancellation and their
 * expiry follows the interview when it is rescheduled.
 */

export type BookingTokenPurpose = 'view' | 'reschedule' | 'cancel';

const VIEW_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

export function tokenExpiries(start: Date, end: Date): Record<BookingTokenPurpose, Date> {
  return { view: new Date(end.getTime() + VIEW_GRACE_MS), reschedule: start, cancel: start };
}

export async function issueBookingTokens(executor: Executor, interviewId: string, start: Date, end: Date) {
  const expiries = tokenExpiries(start, end);
  const raw: Record<BookingTokenPurpose, string> = { view: randomToken(), reschedule: randomToken(), cancel: randomToken() };
  await executor.insert(bookingTokens).values(
    (Object.keys(raw) as BookingTokenPurpose[]).map((purpose) => ({
      interviewId,
      purpose,
      tokenHash: hashToken(raw[purpose]),
      tokenEncrypted: encrypt(raw[purpose]),
      expiresAt: expiries[purpose],
    })),
  );
  return raw;
}

export async function updateTokenExpiries(executor: Executor, interviewId: string, start: Date, end: Date) {
  const expiries = tokenExpiries(start, end);
  for (const purpose of Object.keys(expiries) as BookingTokenPurpose[]) {
    await executor
      .update(bookingTokens)
      .set({ expiresAt: expiries[purpose] })
      .where(and(eq(bookingTokens.interviewId, interviewId), eq(bookingTokens.purpose, purpose), isNull(bookingTokens.revokedAt)));
  }
}

export async function revokeBookingTokens(executor: Executor, interviewId: string, purposes: BookingTokenPurpose[]) {
  for (const purpose of purposes) {
    await executor
      .update(bookingTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(bookingTokens.interviewId, interviewId), eq(bookingTokens.purpose, purpose), isNull(bookingTokens.revokedAt)));
  }
}

export type TokenLookup =
  | { ok: true; interviewId: string; tokenId: string }
  | { ok: false; reason: 'not_found' | 'expired' | 'revoked' };

export async function lookupBookingToken(token: string, purpose: BookingTokenPurpose): Promise<TokenLookup> {
  if (!token || token.length > 128) return { ok: false, reason: 'not_found' };
  const [row] = await db
    .select()
    .from(bookingTokens)
    .where(and(eq(bookingTokens.tokenHash, hashToken(token)), eq(bookingTokens.purpose, purpose)))
    .limit(1);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.revokedAt) return { ok: false, reason: 'revoked' };
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };
  await db.update(bookingTokens).set({ lastUsedAt: new Date() }).where(eq(bookingTokens.id, row.id));
  return { ok: true, interviewId: row.interviewId, tokenId: row.id };
}

export interface BookingLinks {
  view: string | null;
  reschedule: string | null;
  cancel: string | null;
}

/** Candidate-facing URLs for an interview (only for tokens that are still usable). */
export async function bookingLinksFor(interviewId: string, executor: Executor = db): Promise<BookingLinks> {
  const rows = await executor
    .select()
    .from(bookingTokens)
    .where(and(eq(bookingTokens.interviewId, interviewId), isNull(bookingTokens.revokedAt), gt(bookingTokens.expiresAt, new Date())));
  const find = (p: BookingTokenPurpose) => {
    const row = rows.find((r) => r.purpose === p);
    return row ? decrypt(row.tokenEncrypted) : null;
  };
  const view = find('view');
  const reschedule = find('reschedule');
  const cancel = find('cancel');
  return {
    view: view ? appUrl(`/booking/${view}`) : null,
    reschedule: reschedule ? appUrl(`/booking/reschedule/${reschedule}`) : null,
    cancel: cancel ? appUrl(`/booking/cancel/${cancel}`) : null,
  };
}
