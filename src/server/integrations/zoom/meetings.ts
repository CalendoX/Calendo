import { DateTime } from 'luxon';
import { authedRequest } from '../http';
import { IntegrationError, type ConferencingProvider, type MeetingInput, type MeetingResult } from '../types';
import { ZOOM_API } from './oauth';

interface ZoomMeeting {
  id: number | string;
  uuid?: string;
  join_url: string;
  start_url?: string;
  password?: string;
}

/** Zoom expects `yyyy-MM-ddTHH:mm:ssZ` for UTC start times. */
export function zoomStartTime(date: Date): string {
  return DateTime.fromJSDate(date).toUTC().toFormat("yyyy-LL-dd'T'HH:mm:ss'Z'");
}

function meetingBody(input: MeetingInput) {
  return {
    topic: input.topic.slice(0, 200),
    type: 2, // scheduled meeting
    start_time: zoomStartTime(input.start),
    duration: input.durationMinutes,
    timezone: input.timezone,
    agenda: input.agenda.slice(0, 2000),
    settings: {
      host_video: true,
      participant_video: true,
      join_before_host: false,
      waiting_room: true,
      mute_upon_entry: false,
      approval_type: 2, // no registration required
      auto_recording: 'none',
      meeting_invitees: input.invitees.map((i) => ({ email: i.email })),
      email_notification: false,
    },
  };
}

export const zoomProvider: ConferencingProvider = {
  provider: 'zoom',

  async createMeeting(token, input): Promise<MeetingResult> {
    const { data } = await authedRequest<ZoomMeeting>(
      'zoom',
      token,
      { method: 'POST', url: `${ZOOM_API}/users/me/meetings`, body: meetingBody(input) },
      'Create Zoom meeting',
    );
    if (!data?.id || !data.join_url) {
      throw new IntegrationError('zoom', 'transient', 'Zoom returned an incomplete meeting');
    }
    return {
      externalMeetingId: String(data.id),
      joinUrl: data.join_url,
      hostUrl: data.start_url ?? null,
      passcode: data.password ?? null,
    };
  },

  async updateMeeting(token, externalMeetingId, input) {
    // PATCH returns 204 No Content; meeting URLs are unchanged by an update.
    await authedRequest<unknown>(
      'zoom',
      token,
      { method: 'PATCH', url: `${ZOOM_API}/meetings/${encodeURIComponent(externalMeetingId)}`, body: meetingBody(input) },
      'Update Zoom meeting',
    );
    return {};
  },

  async cancelMeeting(token, externalMeetingId) {
    try {
      await authedRequest<unknown>(
        'zoom',
        token,
        {
          method: 'DELETE',
          url: `${ZOOM_API}/meetings/${encodeURIComponent(externalMeetingId)}?schedule_for_reminder=false&cancel_meeting_reminder=false`,
        },
        'Delete Zoom meeting',
      );
    } catch (err) {
      // 404 / Zoom code 3001 "Meeting does not exist": already gone.
      if (err instanceof IntegrationError && (err.kind === 'not_found' || /3001|does not exist/i.test(err.message))) return;
      throw err;
    }
  },

  async getHostUrl(token, externalMeetingId) {
    const { data } = await authedRequest<ZoomMeeting>(
      'zoom',
      token,
      { url: `${ZOOM_API}/meetings/${encodeURIComponent(externalMeetingId)}` },
      'Fetch Zoom meeting',
    );
    return data.start_url ?? null;
  },
};
