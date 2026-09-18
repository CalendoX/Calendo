import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { assertCanViewInterview } from '@/server/authz/policy';
import { db } from '@/server/db/client';
import { integrations, videoMeetings } from '@/server/db/schema';
import { ForbiddenError, NotFoundError } from '@/server/http/errors';
import { apiRoute, authenticate } from '@/server/http/handler';
import { getMeetingHostUrl } from '@/server/integrations/service';
import { decryptNullable } from '@/server/security/crypto';
import { loadInterviewRow } from '../../../_shared';

/**
 * Redirects the interviewer to the Zoom host (start) URL. The URL grants host control, so it is
 * only ever released to the interviewer, freshly fetched from Zoom where possible.
 */
export const GET = apiRoute<{ id: string }>(async (req, { id }) => {
  const auth = await authenticate(req);
  const interview = await loadInterviewRow(id);
  // Interviews the caller cannot see are "not found"; visible ones still require being the host.
  assertCanViewInterview(auth, interview);
  if (interview.hostUserId !== auth.user.id) throw new ForbiddenError('Only the interviewer can start this meeting as host.');
  const [meeting] = await db.select().from(videoMeetings).where(eq(videoMeetings.interviewId, id)).limit(1);
  if (!meeting?.externalMeetingId || meeting.status !== 'synced') throw new NotFoundError('No active meeting for this interview');
  let url: string | null = null;
  if (meeting.integrationId) {
    const [integration] = await db.select().from(integrations).where(eq(integrations.id, meeting.integrationId)).limit(1);
    if (integration?.status === 'active') url = await getMeetingHostUrl(integration, meeting.externalMeetingId).catch(() => null);
  }
  url ??= decryptNullable(meeting.hostUrlEncrypted) ?? meeting.joinUrl;
  if (!url) throw new NotFoundError('No meeting URL available');
  const res = NextResponse.redirect(url, 302);
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
});
