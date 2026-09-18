import type { Metadata } from 'next';
import { BookingDetails } from '@/components/scheduling/booking-details';
import { PublicFrame, PublicMessage } from '@/components/scheduling/public-frame';
import { getCandidateBooking } from '@/server/services/public-service';

export const metadata: Metadata = { title: 'Your interview' };

export default async function BookingPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ rescheduled?: string }> }) {
  const { token } = await params;
  const { rescheduled } = await searchParams;
  const result = await getCandidateBooking(token, 'view');
  if (!result.ok) {
    return (
      <PublicMessage title={result.reason === 'expired' ? 'This link has expired' : 'Booking not found'}>
        {result.reason === 'expired' ? 'Links to past interviews expire after 30 days.' : 'Please check the link in your confirmation email.'}
      </PublicMessage>
    );
  }
  return (
    <PublicFrame width="narrow">
      <BookingDetails view={result.view} token={token} heading={rescheduled ? 'rescheduled' : 'booked'} />
    </PublicFrame>
  );
}
