/**
 * Formatting helpers shared by server code, emails and client components.
 * Pure functions only — safe to import anywhere.
 */

export type LocationKind = 'zoom' | 'google_meet' | 'phone' | 'in_person' | 'custom';

export const LOCATION_LABELS: Record<LocationKind, string> = {
  zoom: 'Zoom',
  google_meet: 'Google Meet',
  phone: 'Phone call',
  in_person: 'In person',
  custom: 'Custom location',
};

export function locationLabel(type: LocationKind, details?: string | null): string {
  if (type === 'zoom' || type === 'google_meet') return LOCATION_LABELS[type];
  if (details && details.trim()) {
    if (type === 'phone') return `Phone call: ${details.trim()}`;
    return details.trim();
  }
  return LOCATION_LABELS[type];
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

export function formatReminderOffset(minutes: number): string {
  if (minutes % 1440 === 0) {
    const d = minutes / 1440;
    return d === 1 ? '24 hours' : `${d} days`;
  }
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return h === 1 ? '1 hour' : `${h} hours`;
  }
  return `${minutes} minutes`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

export function minutesToTime(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function timeToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 24 || m > 59 || (h === 24 && m !== 0)) return null;
  return h * 60 + m;
}

export const INTERVIEW_STATUS_LABELS = {
  scheduled: 'Scheduled',
  rescheduled: 'Rescheduled',
  cancelled: 'Cancelled',
  completed: 'Completed',
  no_show: 'No-show',
} as const;

export const SYNC_STATUS_LABELS = {
  pending: 'Pending',
  synced: 'Synced',
  failed: 'Failed',
  cancelled: 'Removed',
  deleted_externally: 'Deleted outside Calendo',
} as const;
