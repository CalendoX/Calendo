import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db/client';
import { users } from '@/server/db/schema';
import { ValidationError } from '@/server/http/errors';
import { apiRoute, authenticate, json } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { parseJsonBody, zName, zTimeZone } from '@/server/http/validation';
import { recordAudit } from '@/server/services/audit';

const Body = z.object({
  name: zName,
  title: z.string().trim().max(120).nullish(),
  timezone: zTimeZone,
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'Use 3–40 lowercase letters, numbers and dashes'),
});

const RESERVED = new Set(['admin', 'api', 'app', 'login', 'signup', 'settings', 'schedule', 'booking', 'support', 'help', 'www']);

export const PATCH = apiRoute(async (req) => {
  const auth = await authenticate(req);
  const body = await parseJsonBody(req, Body);
  if (RESERVED.has(body.username)) throw new ValidationError('This username is reserved.', { username: ['Reserved'] });
  const [clash] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.username, body.username), ne(users.id, auth.user.id)))
    .limit(1);
  if (clash) throw new ValidationError('This username is taken.', { username: ['Already taken'] });
  await db
    .update(users)
    .set({ name: body.name, title: body.title || null, timezone: body.timezone, username: body.username, updatedAt: new Date() })
    .where(eq(users.id, auth.user.id));
  await recordAudit({
    organizationId: auth.organization.id,
    actor: { type: 'user', userId: auth.user.id },
    action: 'user.profile_updated',
    resourceType: 'user',
    resourceId: auth.user.id,
    metadata: { usernameChanged: body.username !== auth.user.username, timezone: body.timezone },
    meta: requestMeta(req),
  });
  return json({ ok: true });
});
