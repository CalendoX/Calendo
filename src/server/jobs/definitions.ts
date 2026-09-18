import type { Queue } from 'pg-boss';

/**
 * Every background queue the platform uses, with its retry/backoff policy.
 * Queues are created by `npm run db:migrate` and on worker start-up.
 */
export const QUEUES = {
  /** Reconcile an interview's Zoom meeting + calendar event with its current state. */
  interviewSync: 'interview-sync',
  /** Deliver one notification row (email). */
  notificationDeliver: 'notification-deliver',
  /** Account emails: verification, password reset, invitations (URL payload is encrypted). */
  accountEmail: 'account-email',
  /** Process a stored webhook delivery (Google push / Zoom event). */
  webhookProcess: 'webhook-process',
  /** Cron: renew Google Calendar watch channels before they expire. */
  calendarWatchRenew: 'calendar-watch-renew',
  /** Cron: purge expired sessions, tokens, OAuth states and rate-limit windows. */
  maintenanceCleanup: 'maintenance-cleanup',
  /** Cron: mark finished interviews as completed. */
  interviewsComplete: 'interviews-complete',
  /** Cron: safety net that re-enqueues integration work that is still pending/failed. */
  syncSweeper: 'sync-sweeper',
  /** Cron: re-dispatch notifications whose delivery job was lost. */
  notificationSweeper: 'notification-sweeper',
  /** Terminal failures land here for inspection. */
  deadLetter: 'dead-letter',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface JobPayloads {
  'interview-sync': { interviewId: string; reason: string };
  'notification-deliver': { notificationId: string };
  'webhook-process': { webhookEventId: string };
  'account-email': {
    kind: 'verify_email' | 'password_reset' | 'invitation';
    to: string;
    name: string;
    encryptedUrl: string;
    organizationName?: string;
    inviterName?: string;
  };
  'calendar-watch-renew': Record<string, never>;
  'maintenance-cleanup': Record<string, never>;
  'interviews-complete': Record<string, never>;
  'sync-sweeper': Record<string, never>;
  'notification-sweeper': Record<string, never>;
  'dead-letter': Record<string, unknown>;
}

export const QUEUE_CONFIG: Record<QueueName, Omit<Queue, 'name'>> = {
  'interview-sync': {
    // One queued + one active job per interview; the handler reconciles to the latest state.
    policy: 'stately',
    retryLimit: 10,
    retryDelay: 20,
    retryBackoff: true,
    retryDelayMax: 3600,
    expireInSeconds: 180,
    deadLetter: 'dead-letter',
  },
  'notification-deliver': {
    policy: 'standard',
    retryLimit: 6,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 3600,
    expireInSeconds: 90,
    deadLetter: 'dead-letter',
  },
  'account-email': {
    policy: 'standard',
    retryLimit: 5,
    retryDelay: 15,
    retryBackoff: true,
    retryDelayMax: 900,
    expireInSeconds: 60,
    // Short retention: payloads reference security tokens (encrypted, but still minimise).
    deleteAfterSeconds: 60 * 60,
  },
  'webhook-process': {
    policy: 'standard',
    retryLimit: 5,
    retryDelay: 10,
    retryBackoff: true,
    retryDelayMax: 900,
    expireInSeconds: 120,
    deadLetter: 'dead-letter',
  },
  'calendar-watch-renew': { policy: 'singleton', retryLimit: 2, expireInSeconds: 600 },
  'maintenance-cleanup': { policy: 'singleton', retryLimit: 1, expireInSeconds: 600 },
  'interviews-complete': { policy: 'singleton', retryLimit: 1, expireInSeconds: 300 },
  'sync-sweeper': { policy: 'singleton', retryLimit: 1, expireInSeconds: 300 },
  'notification-sweeper': { policy: 'singleton', retryLimit: 1, expireInSeconds: 300 },
  'dead-letter': { policy: 'standard', retentionSeconds: 60 * 60 * 24 * 30, deleteAfterSeconds: 60 * 60 * 24 * 30 },
};

/** Cron schedules (UTC). */
export const SCHEDULES: { queue: QueueName; cron: string }[] = [
  { queue: 'calendar-watch-renew', cron: '17 */6 * * *' },
  { queue: 'maintenance-cleanup', cron: '7 * * * *' },
  { queue: 'interviews-complete', cron: '*/10 * * * *' },
  { queue: 'sync-sweeper', cron: '*/5 * * * *' },
  { queue: 'notification-sweeper', cron: '*/5 * * * *' },
];
