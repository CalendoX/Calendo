import { ArrowRight, Clock } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Avatar } from '@/components/ui/avatar';
import { LocationIcon } from '@/components/scheduling/event-summary';
import { OrgBrand, PublicFrame, PublicMessage } from '@/components/scheduling/public-frame';
import { formatDuration } from '@/lib/format';
import { getPublicProfile } from '@/server/services/public-service';

type Props = { params: Promise<{ username: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { username } = await params;
  const profile = await getPublicProfile(username);
  return { title: profile ? `Schedule with ${profile.host.name}` : 'Schedule an interview' };
}

export default async function PublicProfilePage({ params }: Props) {
  const { username } = await params;
  const profile = await getPublicProfile(username);
  if (!profile) return <PublicMessage title="Page not available">This scheduling page doesn’t exist.</PublicMessage>;
  return (
    <PublicFrame width="narrow">
      <div className="overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-card">
        <div className="border-b border-zinc-100 px-8 py-8 text-center">
          {profile.organization && (
            <div className="mb-5 flex justify-center">
              <OrgBrand name={profile.organization.name} logoUrl={profile.organization.logoUrl} />
            </div>
          )}
          <Avatar name={profile.host.name} size="xl" className="mx-auto" />
          <h1 className="mt-4 text-xl font-semibold text-zinc-900">{profile.host.name}</h1>
          {profile.host.title && <p className="text-sm text-zinc-500">{profile.host.title}</p>}
          <p className="mt-3 text-sm text-zinc-500">Choose an interview type to see available times.</p>
        </div>
        {profile.eventTypes.length === 0 ? (
          <p className="px-8 py-10 text-center text-sm text-zinc-500">There are no interview types available to book right now.</p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {profile.eventTypes.map((e) => (
              <li key={e.slug}>
                <Link href={`/schedule/${profile.host.username}/${e.slug}`} className="group flex items-center gap-4 px-8 py-5 hover:bg-zinc-50">
                  <span className="h-10 w-1 shrink-0 rounded-full" style={{ backgroundColor: e.color }} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-zinc-900">{e.name}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-zinc-500">
                      <span className="inline-flex items-center gap-1.5"><Clock className="size-3.5" /> {formatDuration(e.durationMinutes)}</span>
                      <span className="inline-flex items-center gap-1.5"><LocationIcon type={e.locationType} className="size-3.5" /> {e.locationLabel}</span>
                    </span>
                  </span>
                  <ArrowRight className="size-4 text-zinc-300 transition group-hover:translate-x-0.5 group-hover:text-zinc-500" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </PublicFrame>
  );
}
