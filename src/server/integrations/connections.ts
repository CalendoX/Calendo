import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { AuthContext } from '../auth/session';
import { db } from '../db/client';
import { calendarWatchChannels, integrationCalendars, integrations, oauthStates, type IntegrationProvider } from '../db/schema';
import { BadRequestError, NotFoundError, ServiceUnavailableError, ValidationError } from '../http/errors';
import type { RequestMeta } from '../http/request';
import { decrypt, encrypt, hashToken, pkceChallenge, randomToken } from '../security/crypto';
import { recordAudit } from '../services/audit';
import { googleCalendarProvider, stopWatchChannel } from './google/calendar';
import { GOOGLE_SCOPES } from './google/oauth';
import { ensureWatchChannels } from './google/watch';
import { missingZoomScopes } from './zoom/oauth';
import { oauthAdapters } from './registry';
import { getIntegration, invalidateBusyCache, resyncFailedForUser, tokenSourceFor } from './service';
import { isIntegrationError } from './types';

/**
 * Connection lifecycle: OAuth authorisation (state + PKCE, bound to the signed-in user),
 * token storage, calendar selection and disconnection.
 */

const STATE_TTL_MS = 10 * 60 * 1000;

export interface IntegrationSummary {
  provider: IntegrationProvider;
  configured: boolean;
  connected: boolean;
  status: 'active' | 'error' | 'disconnected' | null;
  accountEmail: string | null;
  connectedAt: string | null;
  lastError: string | null;
  calendars: {
    id: string;
    externalCalendarId: string;
    name: string;
    isPrimary: boolean;
    accessRole: string | null;
    checkConflicts: boolean;
    isWriteTarget: boolean;
    color: string | null;
  }[];
}

/** Sanitised connection status for the UI — never includes credentials. */
export async function listIntegrationsForUser(userId: string): Promise<IntegrationSummary[]> {
  const rows = await db.select().from(integrations).where(eq(integrations.userId, userId));
  const calendars = rows.length
    ? await db
        .select()
        .from(integrationCalendars)
        .where(
          inArray(
            integrationCalendars.integrationId,
            rows.map((r) => r.id),
          ),
        )
    : [];
  return (['google_calendar', 'zoom'] as const).map((provider) => {
    const row = rows.find((r) => r.provider === provider);
    return {
      provider,
      configured: oauthAdapters[provider].isConfigured(),
      connected: Boolean(row),
      status: row?.status ?? null,
      accountEmail: row?.externalAccountEmail ?? null,
      connectedAt: row?.connectedAt.toISOString() ?? null,
      lastError: row?.status === 'error' ? row.lastError : null,
      calendars: calendars
        .filter((c) => c.integrationId === row?.id)
        .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.name.localeCompare(b.name))
        .map((c) => ({
          id: c.id,
          externalCalendarId: c.externalCalendarId,
          name: c.name,
          isPrimary: c.isPrimary,
          accessRole: c.accessRole,
          checkConflicts: c.checkConflicts,
          isWriteTarget: c.isWriteTarget,
          color: c.color,
        })),
    };
  });
}

export async function beginOAuth(ctx: AuthContext, provider: IntegrationProvider, returnTo = '/integrations') {
  const adapter = oauthAdapters[provider];
  if (!adapter.isConfigured()) {
    throw new ServiceUnavailableError(`${adapter.displayName} is not configured on this server. Ask an administrator to set its OAuth credentials.`, 'INTEGRATION_NOT_CONFIGURED');
  }
  const state = randomToken(32);
  const codeVerifier = randomToken(48);
  await db.insert(oauthStates).values({
    stateHash: hashToken(state),
    provider,
    userId: ctx.user.id,
    organizationId: ctx.organization.id,
    codeVerifierEncrypted: encrypt(codeVerifier),
    returnTo: returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/integrations',
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });
  return adapter.buildAuthorizationUrl({ state, codeChallenge: pkceChallenge(codeVerifier) });
}

/**
 * Completes an OAuth authorisation. The state must have been issued to the *same* signed-in
 * user within the last 10 minutes and is single-use.
 */
export async function completeOAuth(
  ctx: AuthContext,
  provider: IntegrationProvider,
  params: { code: string; state: string },
  meta: RequestMeta,
): Promise<{ returnTo: string }> {
  const now = new Date();
  const [stateRow] = await db
    .update(oauthStates)
    .set({ usedAt: now })
    .where(
      and(
        eq(oauthStates.stateHash, hashToken(params.state)),
        eq(oauthStates.provider, provider),
        isNull(oauthStates.usedAt),
        gt(oauthStates.expiresAt, now),
      ),
    )
    .returning();
  if (!stateRow || stateRow.userId !== ctx.user.id || stateRow.organizationId !== ctx.organization.id) {
    throw new BadRequestError('This authorization request is invalid or has expired. Please try connecting again.', 'INVALID_OAUTH_STATE');
  }

  const adapter = oauthAdapters[provider];
  const tokens = await adapter.exchangeCode(params.code, decrypt(stateRow.codeVerifierEncrypted));
  if (provider === 'google_calendar') {
    const required = GOOGLE_SCOPES.filter((s) => s.startsWith('https://'));
    const missing = tokens.scopes.length ? required.filter((s) => !tokens.scopes.includes(s)) : [];
    if (missing.length) {
      await adapter.revoke(tokens.accessToken).catch(() => undefined);
      throw new ValidationError('Calendar access was not granted. Please connect again and allow Calendo to view and edit your calendar events.', {
        scopes: missing,
      });
    }
  }
  if (provider === 'zoom') {
    // A Marketplace app missing scopes still authorises, then fails on the first API call; say which ones.
    const missing = tokens.scopes.length ? missingZoomScopes(tokens.scopes) : [];
    if (missing.length) {
      throw new ValidationError(`The Zoom app is missing scopes: ${missing.join(', ')}. Add them on marketplace.zoom.us, then connect again.`, {
        scopes: missing,
      });
    }
  }
  const account = await adapter.fetchAccount(tokens.accessToken);

  const existing = await getIntegration(ctx.user.id, provider);
  const values = {
    organizationId: ctx.organization.id,
    userId: ctx.user.id,
    provider,
    status: 'active' as const,
    externalAccountId: account.id,
    externalAccountEmail: account.email,
    accessTokenEncrypted: encrypt(tokens.accessToken),
    refreshTokenEncrypted: tokens.refreshToken
      ? encrypt(tokens.refreshToken)
      : existing?.externalAccountId === account.id
        ? existing.refreshTokenEncrypted
        : null,
    tokenExpiresAt: tokens.expiresAt,
    scopes: tokens.scopes,
    lastError: null,
    lastErrorAt: null,
    connectedAt: now,
    updatedAt: now,
  };
  if (!values.refreshTokenEncrypted) {
    throw new BadRequestError(`${adapter.displayName} did not grant offline access. Please try connecting again.`, 'NO_REFRESH_TOKEN');
  }

  let integrationId: string;
  if (existing && existing.externalAccountId !== account.id) {
    // Switching to a different account: drop calendars/channels of the old one.
    await db.delete(integrations).where(eq(integrations.id, existing.id));
  }
  if (existing && existing.externalAccountId === account.id) {
    await db.update(integrations).set(values).where(eq(integrations.id, existing.id));
    integrationId = existing.id;
  } else {
    const [row] = await db.insert(integrations).values(values).returning({ id: integrations.id });
    integrationId = row.id;
  }

  if (provider === 'google_calendar') {
    await syncCalendarList(integrationId);
    await ensureWatchChannels(integrationId).catch((err) => console.warn('[google] watch registration failed', err));
    invalidateBusyCache(integrationId);
  }

  await recordAudit({
    organizationId: ctx.organization.id,
    actor: { type: 'user', userId: ctx.user.id },
    action: 'integration.connected',
    resourceType: 'integration',
    resourceId: integrationId,
    metadata: { provider, accountEmail: account.email },
    meta,
  });

  await resyncFailedForUser(ctx.user.id, provider).catch((err) => console.warn('[integrations] resync enqueue failed', err));
  return { returnTo: stateRow.returnTo ?? '/integrations' };
}

/** Refreshes the stored calendar list, preserving the user's selections. */
export async function syncCalendarList(integrationId: string) {
  const calendars = await googleCalendarProvider.listCalendars(tokenSourceFor(integrationId));
  const existing = await db.select().from(integrationCalendars).where(eq(integrationCalendars.integrationId, integrationId));
  const firstConnect = existing.length === 0;
  const byExternal = new Map(existing.map((c) => [c.externalCalendarId, c]));

  await db.transaction(async (tx) => {
    for (const cal of calendars) {
      const prev = byExternal.get(cal.id);
      if (prev) {
        await tx
          .update(integrationCalendars)
          .set({ name: cal.name, timezone: cal.timezone, isPrimary: cal.isPrimary, accessRole: cal.accessRole, color: cal.color })
          .where(eq(integrationCalendars.id, prev.id));
      } else {
        await tx.insert(integrationCalendars).values({
          integrationId,
          externalCalendarId: cal.id,
          name: cal.name,
          timezone: cal.timezone,
          isPrimary: cal.isPrimary,
          accessRole: cal.accessRole,
          color: cal.color,
          checkConflicts: firstConnect && cal.isPrimary,
          isWriteTarget: firstConnect && cal.isPrimary,
        });
      }
    }
    const current = new Set(calendars.map((c) => c.id));
    const removed = existing.filter((c) => !current.has(c.externalCalendarId)).map((c) => c.id);
    if (removed.length) await tx.delete(integrationCalendars).where(inArray(integrationCalendars.id, removed));
  });
}

export async function updateCalendarSelection(
  ctx: AuthContext,
  input: { writeCalendarId: string | null; conflictCalendarIds: string[] },
  meta: RequestMeta,
) {
  const integration = await getIntegration(ctx.user.id, 'google_calendar');
  if (!integration) throw new NotFoundError('Google Calendar is not connected');
  const calendars = await db.select().from(integrationCalendars).where(eq(integrationCalendars.integrationId, integration.id));
  const byId = new Map(calendars.map((c) => [c.id, c]));
  for (const id of input.conflictCalendarIds) if (!byId.has(id)) throw new ValidationError('Unknown calendar selected');
  if (input.writeCalendarId) {
    const target = byId.get(input.writeCalendarId);
    if (!target) throw new ValidationError('Unknown calendar selected');
    if (!['owner', 'writer'].includes(target.accessRole ?? '')) {
      throw new ValidationError('Interviews can only be added to a calendar you can edit');
    }
  }
  await db.transaction(async (tx) => {
    await tx
      .update(integrationCalendars)
      .set({ isWriteTarget: false, checkConflicts: false })
      .where(eq(integrationCalendars.integrationId, integration.id));
    if (input.conflictCalendarIds.length) {
      await tx
        .update(integrationCalendars)
        .set({ checkConflicts: true })
        .where(and(eq(integrationCalendars.integrationId, integration.id), inArray(integrationCalendars.id, input.conflictCalendarIds)));
    }
    if (input.writeCalendarId) {
      await tx
        .update(integrationCalendars)
        .set({ isWriteTarget: true })
        .where(and(eq(integrationCalendars.integrationId, integration.id), eq(integrationCalendars.id, input.writeCalendarId)));
    }
  });
  invalidateBusyCache(integration.id);
  await ensureWatchChannels(integration.id).catch((err) => console.warn('[google] watch registration failed', err));
  await recordAudit({
    organizationId: ctx.organization.id,
    actor: { type: 'user', userId: ctx.user.id },
    action: 'integration.calendars_updated',
    resourceType: 'integration',
    resourceId: integration.id,
    metadata: {
      writeCalendar: input.writeCalendarId ? byId.get(input.writeCalendarId)?.name : null,
      conflictCalendars: input.conflictCalendarIds.map((id) => byId.get(id)?.name),
    },
    meta,
  });
}

/**
 * Disconnects: stops push channels, revokes tokens at the provider (best effort), and deletes
 * the stored credentials. Existing events/meetings are left in place on the provider side.
 */
export async function disconnectIntegration(ctx: AuthContext, provider: IntegrationProvider, meta: RequestMeta) {
  const integration = await getIntegration(ctx.user.id, provider);
  if (!integration) throw new NotFoundError('Integration is not connected');

  if (provider === 'google_calendar') {
    const channels = await db.select().from(calendarWatchChannels).where(eq(calendarWatchChannels.integrationId, integration.id));
    for (const ch of channels) {
      if (ch.resourceId) {
        await stopWatchChannel(tokenSourceFor(integration.id), ch.channelId, ch.resourceId).catch(() => undefined);
      }
    }
  }
  try {
    const token = integration.refreshTokenEncrypted
      ? decrypt(integration.refreshTokenEncrypted)
      : integration.accessTokenEncrypted
        ? decrypt(integration.accessTokenEncrypted)
        : null;
    if (token) await oauthAdapters[provider].revoke(token);
  } catch (err) {
    console.warn(`[integrations] revoke failed for ${provider}:`, isIntegrationError(err) ? err.message : err);
  }
  await db.delete(integrations).where(eq(integrations.id, integration.id));
  invalidateBusyCache(integration.id);
  await recordAudit({
    organizationId: ctx.organization.id,
    actor: { type: 'user', userId: ctx.user.id },
    action: 'integration.disconnected',
    resourceType: 'integration',
    resourceId: integration.id,
    metadata: { provider, accountEmail: integration.externalAccountEmail },
    meta,
  });
}
