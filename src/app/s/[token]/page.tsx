import { redirect } from 'next/navigation';
import { PublicMessage } from '@/components/scheduling/public-frame';
import { resolveSchedulingLinkTarget } from '@/server/services/public-service';

/** Personal scheduling link → the event type's booking page (the link is validated there). */
export default async function SchedulingLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const target = token.length <= 128 ? await resolveSchedulingLinkTarget(token) : null;
  if (!target) return <PublicMessage title="Link not found">This scheduling link isn’t valid. Please check it with your recruiter.</PublicMessage>;
  redirect(`/schedule/${target.username}/${target.slug}?link=${encodeURIComponent(token)}`);
}
