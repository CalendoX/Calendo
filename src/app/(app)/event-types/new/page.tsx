import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { EventTypeEditor } from '@/components/event-types/event-type-editor';
import { PageHeader } from '@/components/ui/page-header';
import { requirePageAuth } from '@/server/auth/page-guards';
import { appUrl } from '@/server/config/env';
import { editorData } from '../_editor-data';

export const metadata: Metadata = { title: 'New event type' };

export default async function NewEventTypePage({ searchParams }: { searchParams: Promise<{ host?: string }> }) {
  const auth = await requirePageAuth('/event-types/new');
  const { host } = await searchParams;
  const data = await editorData(auth);
  const hostUserId = data.canAssignHost && host && data.hosts.some((h) => h.id === host) ? host : auth.user.id;
  return (
    <>
      <Link href="/event-types" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-zinc-500 hover:text-zinc-800">
        <ArrowLeft className="size-4" /> Event types
      </Link>
      <PageHeader title="New event type" description="Define an interview format candidates can book." />
      <EventTypeEditor
        mode="create"
        initial={{
          name: '',
          slug: '',
          description: '',
          color: auth.organization.brandColor,
          durationMinutes: 60,
          locationType: 'zoom',
          locationDetails: '',
          hostUserId,
          scheduleId: null,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 15,
          minimumNoticeMinutes: 24 * 60,
          maxDaysInFuture: 30,
          slotIntervalMinutes: null,
          dailyLimit: null,
          isActive: true,
          visibility: 'public',
          questions: [],
          fieldConfig: { phone: 'optional', company: 'hidden', linkedinUrl: 'optional', resumeUrl: 'optional' },
          reminderOffsetsMinutes: null,
        }}
        publicBaseUrl={appUrl()}
        {...data}
      />
    </>
  );
}
