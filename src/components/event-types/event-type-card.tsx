'use client';

import { Clock, Copy, ExternalLink, Link2, MoreHorizontal, Pencil, Trash2, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { LocationIcon } from '@/components/scheduling/event-summary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dropdown, DropdownContent, DropdownItem, DropdownSeparator, DropdownTrigger } from '@/components/ui/dropdown';
import { Switch } from '@/components/ui/switch';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { formatDuration, locationLabel } from '@/lib/format';
import type { EventTypeListItem } from '@/server/services/event-types-service';

export function EventTypeCard({ item, showHost, canManage }: { item: EventTypeListItem; showHost?: boolean; canManage: boolean }) {
  const router = useRouter();
  const [active, setActive] = useState(item.isActive);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function toggle(next: boolean) {
    setActive(next);
    try {
      await api(`/api/event-types/${item.id}`, { method: 'PATCH', body: { isActive: next } });
      toast.success(next ? 'Now accepting bookings' : 'Bookings paused');
      router.refresh();
    } catch (err) {
      setActive(!next);
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className={cn('group flex flex-col overflow-hidden rounded-xl border border-zinc-200/80 bg-white shadow-card transition hover:shadow-sm', !active && 'bg-zinc-50/80')}>
      <div className="h-1.5" style={{ backgroundColor: active ? item.color : '#d4d4d8' }} />
      <div className="flex flex-1 flex-col p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Link href={canManage ? `/event-types/${item.id}` : item.publicUrl} className="block truncate text-base font-semibold text-zinc-900 hover:underline">
              {item.name}
            </Link>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-zinc-500">
              <span className="inline-flex items-center gap-1.5"><Clock className="size-3.5" /> {formatDuration(item.durationMinutes)}</span>
              <span className="inline-flex items-center gap-1.5"><LocationIcon type={item.locationType} className="size-3.5" /> {locationLabel(item.locationType, item.locationDetails)}</span>
            </p>
          </div>
          {canManage && (
            <Dropdown>
              <DropdownTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Event type actions">
                  <MoreHorizontal />
                </Button>
              </DropdownTrigger>
              <DropdownContent>
                <DropdownItem asChild>
                  <Link href={`/event-types/${item.id}`}>
                    <Pencil /> Edit
                  </Link>
                </DropdownItem>
                <DropdownItem asChild>
                  <Link href={`/event-types/${item.id}#links`}>
                    <Link2 /> Single-use links
                  </Link>
                </DropdownItem>
                <DropdownItem asChild>
                  <a href={item.publicUrl} target="_blank" rel="noreferrer">
                    <ExternalLink /> Preview booking page
                  </a>
                </DropdownItem>
                <DropdownSeparator />
                <DropdownItem destructive onSelect={() => setConfirmDelete(true)}>
                  <Trash2 /> Delete
                </DropdownItem>
              </DropdownContent>
            </Dropdown>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {item.visibility === 'link_only' && <Badge tone="violet">Private link only</Badge>}
          {!item.zoomReady && <Badge tone="amber">Zoom not connected</Badge>}
          {showHost && (
            <Badge>
              <Users className="size-3" /> {item.host.name}
            </Badge>
          )}
        </div>
        <p className="mt-3 text-xs text-zinc-500">
          {item.upcomingCount} upcoming · {item.totalCount} total
        </p>
        <div className="mt-auto flex items-center justify-between gap-2 border-t border-zinc-100 pt-4 [margin-top:max(1rem,auto)]">
          <Button
            variant="secondary"
            size="sm"
            disabled={!active || item.visibility === 'link_only'}
            onClick={() => navigator.clipboard.writeText(item.publicUrl).then(() => toast.success('Scheduling link copied'))}
          >
            <Copy /> Copy link
          </Button>
          {canManage && (
            <label className="flex items-center gap-2 text-xs font-medium text-zinc-500">
              {active ? 'On' : 'Off'}
              <Switch checked={active} onCheckedChange={toggle} aria-label="Accepting bookings" />
            </label>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${item.name}”?`}
        description="The booking link stops working immediately. Existing interviews are kept and are not cancelled."
        confirmLabel="Delete event type"
        onConfirm={async () => {
          try {
            await api(`/api/event-types/${item.id}`, { method: 'DELETE' });
            toast.success('Event type deleted');
            setConfirmDelete(false);
            router.refresh();
          } catch (err) {
            toast.error(errorMessage(err));
          }
        }}
      />
    </div>
  );
}
