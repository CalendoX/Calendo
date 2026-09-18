import { Clock, Globe2, MapPin, Phone, Video } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { formatDuration } from '@/lib/format';
import { OrgBrand } from './public-frame';

export function LocationIcon({ type, className }: { type: string; className?: string }) {
  if (type === 'zoom' || type === 'google_meet') return <Video className={className} />;
  if (type === 'phone') return <Phone className={className} />;
  return <MapPin className={className} />;
}

/** Left-hand summary panel of the public booking page. */
export function EventSummary({
  organization,
  host,
  eventType,
  timezoneLabel,
  children,
}: {
  organization: { name: string; logoUrl: string | null };
  host: { name: string; title: string | null };
  eventType: { name: string; durationMinutes: number; locationType: string; locationLabel: string; description: string | null };
  timezoneLabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-6">
      <OrgBrand name={organization.name} logoUrl={organization.logoUrl} />
      <div className="flex items-center gap-3">
        <Avatar name={host.name} size="lg" />
        <div>
          <p className="text-sm font-medium text-zinc-500">{host.name}</p>
          {host.title && <p className="text-xs text-zinc-400">{host.title}</p>}
        </div>
      </div>
      <h1 className="text-2xl font-semibold leading-tight tracking-tight text-zinc-900">{eventType.name}</h1>
      <ul className="space-y-3 text-sm font-medium text-zinc-600">
        <li className="flex items-center gap-2.5">
          <Clock className="size-[18px] text-zinc-400" /> {formatDuration(eventType.durationMinutes)}
        </li>
        <li className="flex items-start gap-2.5">
          <LocationIcon type={eventType.locationType} className="mt-px size-[18px] shrink-0 text-zinc-400" />
          <span>{eventType.locationType === 'zoom' ? 'Zoom video call — link provided on confirmation' : eventType.locationLabel}</span>
        </li>
        {timezoneLabel && (
          <li className="flex items-center gap-2.5">
            <Globe2 className="size-[18px] text-zinc-400" /> {timezoneLabel}
          </li>
        )}
      </ul>
      {children}
      {eventType.description && <p className="whitespace-pre-line text-sm leading-relaxed text-zinc-600">{eventType.description}</p>}
    </div>
  );
}
