import type { IntegrationProvider } from '../db/schema';
import { googleCalendarProvider } from './google/calendar';
import { googleOAuth } from './google/oauth';
import type { CalendarProvider, ConferencingProvider, OAuthAdapter } from './types';
import { zoomOAuth } from './zoom/oauth';
import { zoomProvider } from './zoom/meetings';

/**
 * Provider registry. To add Outlook: implement OAuthAdapter + CalendarProvider and register them
 * here (and add the enum value). To add Google Meet: implement ConferencingProvider.
 */
export const oauthAdapters: Record<IntegrationProvider, OAuthAdapter> = {
  google_calendar: googleOAuth,
  zoom: zoomOAuth,
};

export const calendarProviders: Partial<Record<IntegrationProvider, CalendarProvider>> = {
  google_calendar: googleCalendarProvider,
};

export const conferencingProviders: Partial<Record<IntegrationProvider, ConferencingProvider>> = {
  zoom: zoomProvider,
};

/** Maps an event-type location to the provider that creates its meeting. */
export const LOCATION_CONFERENCING_PROVIDER: Partial<Record<string, IntegrationProvider>> = {
  zoom: 'zoom',
};

export function isProviderSlug(value: string): value is 'google' | 'zoom' {
  return value === 'google' || value === 'zoom';
}

export function providerFromSlug(slug: 'google' | 'zoom'): IntegrationProvider {
  return slug === 'google' ? 'google_calendar' : 'zoom';
}

export function slugFromProvider(provider: IntegrationProvider): 'google' | 'zoom' {
  return provider === 'google_calendar' ? 'google' : 'zoom';
}
