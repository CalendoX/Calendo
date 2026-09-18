import type { Metadata } from 'next';
import { BookingFlow } from '@/components/scheduling/booking-flow';
import { PublicFrame, PublicMessage } from '@/components/scheduling/public-frame';
import { isAppError } from '@/server/http/errors';
import { resolvePublicEventType, type ResolvedPublicEvent } from '@/server/services/public-service';

type Props = { params: Promise<{ username: string; eventSlug: string }>; searchParams: Promise<{ link?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { username, eventSlug } = await params;
  try {
    const r = await resolvePublicEventType(username, eventSlug, null);
    return { title: `${r.eventType.name} with ${r.host.name}` };
  } catch {
    return { title: 'Schedule an interview' };
  }
}

export default async function PublicBookingPage({ params, searchParams }: Props) {
  const { username, eventSlug } = await params;
  const { link } = await searchParams;
  let resolved: ResolvedPublicEvent;
  try {
    resolved = await resolvePublicEventType(username, eventSlug, link ?? null);
  } catch (err) {
    if (isAppError(err) && err.status === 410) {
      return <PublicMessage title="This link can’t be used">{err.message}</PublicMessage>;
    }
    if (isAppError(err) && err.status === 404) {
      return <PublicMessage title="Page not available">This scheduling page doesn’t exist or is no longer accepting bookings. Please check the link with your recruiter.</PublicMessage>;
    }
    throw err;
  }
  return (
    <PublicFrame>
      <BookingFlow
        username={resolved.host.username}
        eventSlug={resolved.eventType.slug}
        linkToken={link ?? null}
        organization={resolved.organization}
        host={resolved.host}
        eventType={resolved.eventType}
        prefill={resolved.link ? { name: resolved.link.candidateName, email: resolved.link.candidateEmail } : null}
      />
    </PublicFrame>
  );
}
