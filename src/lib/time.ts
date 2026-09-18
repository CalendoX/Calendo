import { DateTime } from 'luxon';

/** Client-side time helpers (all display conversion happens from UTC ISO instants). */

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function allTimeZones(): string[] {
  try {
    const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone');
    if (zones?.length) return zones.includes('UTC') ? zones : ['UTC', ...zones];
  } catch {
    /* fall through */
  }
  return ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney'];
}

export function zoneOffsetLabel(zone: string, at: Date = new Date()): string {
  const dt = DateTime.fromJSDate(at, { zone });
  return dt.isValid ? `GMT${dt.toFormat('ZZ')}` : '';
}

export function zoneLabel(zone: string): string {
  return zone.replace(/_/g, ' ').replace(/\//g, ' / ');
}

export function fmt(iso: string | Date, zone: string, format: string): string {
  const dt = typeof iso === 'string' ? DateTime.fromISO(iso, { zone }) : DateTime.fromJSDate(iso, { zone });
  return dt.toFormat(format);
}

export function fmtTime(iso: string, zone: string, hour12 = true) {
  return fmt(iso, zone, hour12 ? 'h:mm a' : 'HH:mm');
}

export function fmtDate(iso: string, zone: string) {
  return fmt(iso, zone, 'ccc, LLL d, yyyy');
}

export function fmtRange(startIso: string, endIso: string, zone: string, hour12 = true) {
  return `${fmtTime(startIso, zone, hour12)} – ${fmtTime(endIso, zone, hour12)}`;
}

export function relativeDay(iso: string, zone: string): string {
  const d = DateTime.fromISO(iso, { zone }).startOf('day');
  const today = DateTime.now().setZone(zone).startOf('day');
  const diff = Math.round(d.diff(today, 'days').days);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return d.toFormat(diff > 0 && diff < 7 ? 'cccc' : 'ccc, LLL d');
}

export function timeFromNow(iso: string): string {
  const rel = DateTime.fromISO(iso).toRelative({ style: 'short' });
  return rel ?? '';
}
