import { ArrowLeft, ExternalLink } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EventTypeEditor } from '@/components/event-types/event-type-editor';
import { SchedulingLinksPanel } from '@/components/event-types/scheduling-links-panel';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { PageHeader } from '@/components/ui/page-header';
import { requirePageAuth } from '@/server/auth/page-guards';
import { appUrl } from '@/server/config/env';
import { isAppError } from '@/server/http/errors';
import { getEventType } from '@/server/services/event-types-service';
import { editorData } from '../_editor-data';

export const metadata: Metadata = { title: 'Edit event type' };

export default async function EditEventTypePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  const { id } = await params;
  const { created } = await searchParams;
  const auth = await requirePageAuth(`/event-types/${id}`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let et: Awaited<ReturnType<typeof getEventType>>;
  try {
    et = await getEventType(auth, id);
  } catch (err) {
    if (isAppError(err) && (err.status === 404 || err.status === 403)) notFound();
    throw err;
  }
  const data = await editorData(auth);
  const e = et.eventType;
  return (
    <>
      <Link href="/event-types" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-zinc-500 hover:text-zinc-800">
        <ArrowLeft className="size-4" /> Event types
      </Link>
      <PageHeader
        title={e.name}
        description={`Hosted by ${et.host.name}`}
        actions={
          <>
            <CopyButton value={et.publicUrl} label="Copy link" />
            <Button asChild variant="secondary" size="sm">
              <a href={et.publicUrl} target="_blank" rel="noreferrer">
                <ExternalLink /> Preview
              </a>
            </Button>
          </>
        }
      />
      {created && (
        <Alert tone="success" title="Your event type is live" className="mb-6">
          Share <span className="font-medium">{et.publicUrl}</span> with candidates, or create a personal single-use link below.
        </Alert>
      )}
      <div className="grid gap-6 2xl:grid-cols-[1fr_420px]">
        <EventTypeEditor
          mode="edit"
          eventTypeId={e.id}
          initial={{
            name: e.name,
            slug: e.slug,
            description: e.description ?? '',
            color: e.color,
            durationMinutes: e.durationMinutes,
            locationType: e.locationType,
            locationDetails: e.locationDetails ?? '',
            hostUserId: e.hostUserId,
            scheduleId: e.scheduleId,
            bufferBeforeMinutes: e.bufferBeforeMinutes,
            bufferAfterMinutes: e.bufferAfterMinutes,
            minimumNoticeMinutes: e.minimumNoticeMinutes,
            maxDaysInFuture: e.maxDaysInFuture,
            slotIntervalMinutes: e.slotIntervalMinutes,
            dailyLimit: e.dailyLimit,
            isActive: e.isActive,
            visibility: e.visibility,
            questions: e.questions,
            fieldConfig: e.fieldConfig,
            reminderOffsetsMinutes: e.reminderOffsetsMinutes,
          }}
          publicBaseUrl={appUrl()}
          {...data}
        />
        <div>
          <SchedulingLinksPanel eventTypeId={e.id} timezone={auth.user.timezone} />
        </div>
      </div>
    </>
  );
}
