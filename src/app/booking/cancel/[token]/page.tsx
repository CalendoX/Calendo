import type { Metadata } from 'next';
import { BookingDetails } from '@/components/scheduling/booking-details';
import { CandidateCancel } from '@/components/scheduling/candidate-manage';
import { PublicFrame, PublicMessage } from '@/components/scheduling/public-frame';
import { getCandidateBooking } from '@/server/services/public-service';
import { db } from '@/server/db/client';
import { bookingTokens } from '@/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { decrypt, hashToken } from '@/server/security/crypto';

export const metadata: Metadata = { title: 'Cancel your interview' };

async function viewTokenForCancelToken(token: string) {
  const [row] = await db.select({ interviewId: bookingTokens.interviewId }).from(bookingTokens).where(and(eq(bookingTokens.tokenHash, hashToken(token)), eq(bookingTokens.purpose, 'cancel'))).limit(1);
  if (!row) return null;
  const [view] = await db.select().from(bookingTokens).where(and(eq(bookingTokens.interviewId, row.interviewId), eq(bookingTokens.purpose, 'view'))).limit(1);
  return view ? decrypt(view.tokenEncrypted) : null;
}

export default async function CancelPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await getCandidateBooking(token, 'cancel');
  if (!result.ok) {
    // A revoked cancel token usually means the interview is already cancelled — show its state.
    if (result.reason === 'revoked') {
      const viewToken = await viewTokenForCancelToken(token);
      const view = viewToken ? await getCandidateBooking(viewToken, 'view') : null;
      if (view?.ok) {
        return (
          <PublicFrame width="narrow">
            <BookingDetails view={view.view} token={viewToken} />
          </PublicFrame>
        );
      }
    }
    return (
      <PublicMessage title={result.reason === 'expired' ? 'This link has expired' : 'Link not valid'}>
        {result.reason === 'expired' ? 'Interviews can’t be cancelled online once they’ve started.' : 'Please check the cancellation link in your email.'}
      </PublicMessage>
    );
  }
  const v = result.view;
  return (
    <PublicFrame width="narrow">
      <div className="space-y-4">
        <BookingDetails view={{ ...v, policy: { ...v.policy, canCancel: false, canReschedule: false, reason: null } }} token={null} heading="details" />
        {v.policy.canCancel ? (
          <div className="rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-card sm:px-10">
            <h2 className="mb-4 text-base font-semibold text-zinc-900">Cancel this interview?</h2>
            <CandidateCancel token={token} />
          </div>
        ) : (
          v.policy.reason && <p className="text-center text-sm text-zinc-500">{v.policy.reason}</p>
        )}
      </div>
    </PublicFrame>
  );
}
