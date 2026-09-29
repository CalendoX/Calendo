/**
 * Best-effort operating system and device class of the browser that sent a request.
 *
 * Chromium browsers send the `Sec-CH-UA-Platform` / `Sec-CH-UA-Mobile` client hints by default
 * over HTTPS, and those are preferred because they are not frozen the way Chrome's User-Agent
 * string is. Everything else falls back to parsing the User-Agent. Both are supplied by the
 * client, so the result is informational only and must never gate anything.
 *
 * iPads running Safari on iPadOS 13+ present themselves as a Mac, so they are reported as macOS.
 */

export type ClientOs = 'Windows' | 'macOS' | 'Linux' | 'ChromeOS' | 'Android' | 'iOS' | 'iPadOS' | 'Other';
export type ClientDevice = 'desktop' | 'mobile' | 'tablet';

export interface ClientPlatform {
  os: ClientOs;
  device: ClientDevice;
  /** Raw User-Agent (truncated), kept so the detection can be re-checked later. */
  userAgent: string | null;
}

const HINT_PLATFORMS: Record<string, ClientOs> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  'chrome os': 'ChromeOS',
  chromeos: 'ChromeOS',
  android: 'Android',
  ios: 'iOS',
};

/** Structured-header strings arrive quoted: `"Windows"`. */
function unquote(value: string | null) {
  return value?.trim().replace(/^"|"$/g, '') ?? '';
}

function osFromUserAgent(ua: string): ClientOs {
  if (/iPad/.test(ua)) return 'iPadOS';
  if (/iPhone|iPod/.test(ua)) return 'iOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Macintosh|Mac OS X/.test(ua)) return 'macOS';
  if (/Linux|X11|Ubuntu|Fedora/i.test(ua)) return 'Linux';
  return 'Other';
}

function deviceFromUserAgent(ua: string, os: ClientOs): ClientDevice {
  if (os === 'iPadOS' || /Tablet/i.test(ua)) return 'tablet';
  // Android tablets drop the "Mobile" token from their User-Agent.
  if (os === 'Android') return /Mobile/.test(ua) ? 'mobile' : 'tablet';
  if (os === 'iOS' || /Mobi|Windows Phone/i.test(ua)) return 'mobile';
  return 'desktop';
}

export function detectClientPlatform(headers: Headers): ClientPlatform {
  const ua = headers.get('user-agent')?.slice(0, 512) ?? null;
  const uaOs = ua ? osFromUserAgent(ua) : 'Other';
  const hintOs = HINT_PLATFORMS[unquote(headers.get('sec-ch-ua-platform')).toLowerCase()];
  const os = hintOs ?? uaOs;

  let device = ua ? deviceFromUserAgent(ua, os) : 'desktop';
  const mobileHint = headers.get('sec-ch-ua-mobile')?.trim();
  if (mobileHint === '?1') device = 'mobile';
  // A phone OS that says "not mobile" is a tablet (Chrome on Android tablets reports it this way).
  if (mobileHint === '?0' && device === 'mobile') device = os === 'Android' || os === 'iOS' ? 'tablet' : 'desktop';

  return { os, device, userAgent: ua };
}
