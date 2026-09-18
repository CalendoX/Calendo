import { and, eq, inArray } from 'drizzle-orm';
import type { AuthContext } from '@/server/auth/session';
import { isAdmin } from '@/server/authz/policy';
import { db } from '@/server/db/client';
import { integrations, users } from '@/server/db/schema';
import { assignableHosts } from '@/server/services/event-types-service';
import { schedulesForHost } from '@/server/services/schedules-service';
import { DEFAULT_REMINDER_OFFSETS } from '@/server/notifications/planner';

/** Everything the event type editor needs besides the event type itself. */
export async function editorData(auth: AuthContext) {
  const hosts = await assignableHosts(auth);
  const hostIds = hosts.map((h) => h.id);
  const [schedules, zoom, usernames] = await Promise.all([
    schedulesForHost(auth, hostIds),
    db
      .select({ userId: integrations.userId })
      .from(integrations)
      .where(and(eq(integrations.provider, 'zoom'), eq(integrations.status, 'active'), inArray(integrations.userId, hostIds))),
    db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, hostIds)),
  ]);
  return {
    hosts: hosts.map((h) => ({ ...h, username: usernames.find((u) => u.id === h.id)?.username ?? '' })),
    schedules,
    zoomConnectedHostIds: zoom.map((z) => z.userId),
    canAssignHost: isAdmin(auth),
    orgReminderDefault: auth.organization.settings.reminderOffsetsMinutes ?? DEFAULT_REMINDER_OFFSETS,
  };
}
