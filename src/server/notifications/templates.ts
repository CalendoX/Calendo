import { DateTime } from 'luxon';
import type { NotificationType } from '../db/schema';
import { firstName, formatDuration, formatReminderOffset, locationLabel, type LocationKind } from '@/lib/format';

/**
 * Transactional email templates. Every interpolated value is HTML-escaped by the `html`
 * tagged template; only trusted fragments built here are passed through `raw()`.
 * Organisations may override the subject and intro paragraph of each email (with a small,
 * safe placeholder language: {{candidate_name}}, {{event_name}}, …).
 */

class Raw {
  constructor(public readonly value: string) {}
}
export const raw = (value: string) => new Raw(value);

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0];
  values.forEach((v, i) => {
    if (v instanceof Raw) out += v.value;
    else if (Array.isArray(v)) out += v.map((x) => (x instanceof Raw ? x.value : escapeHtml(x))).join('');
    else if (v === null || v === undefined || v === false) out += '';
    else out += escapeHtml(v);
    out += strings[i + 1];
  });
  return new Raw(out);
}

export interface EmailContext {
  type: NotificationType;
  recipient: { name: string; email: string; kind: 'candidate' | 'host'; timezone: string };
  organization: { name: string; brandColor: string; logoUrl: string | null };
  eventType: { name: string; durationMinutes: number };
  host: { name: string; email: string; title: string | null };
  candidate: { name: string; email: string; phone: string | null; linkedinUrl: string | null; resumeUrl: string | null; company: string | null };
  interview: {
    id: string;
    start: Date;
    end: Date;
    locationType: LocationKind;
    locationDetails: string | null;
    responses: { label: string; answer: string }[];
    cancelReason: string | null;
  };
  meeting: { joinUrl: string | null; passcode: string | null; pending: boolean } | null;
  links: {
    view: string | null;
    reschedule: string | null;
    cancel: string | null;
    dashboard: string;
    googleCalendar: string | null;
    outlookCalendar: string | null;
    bookAgain: string | null;
  };
  metadata: Record<string, unknown>;
  override?: { subject: string | null; intro: string | null } | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function when(ctx: EmailContext, start = ctx.interview.start, end = ctx.interview.end) {
  const tz = ctx.recipient.timezone;
  const s = DateTime.fromJSDate(start, { zone: tz });
  const e = DateTime.fromJSDate(end, { zone: tz });
  return {
    date: s.toFormat('cccc, LLLL d, yyyy'),
    shortDate: s.toFormat('ccc, LLL d'),
    time: `${s.toFormat('h:mm a')} – ${e.toFormat('h:mm a')}`,
    zone: `${tz.replace(/_/g, ' ')} (${s.toFormat('ZZZZ')})`,
  };
}

function placeholders(ctx: EmailContext): Record<string, string> {
  const w = when(ctx);
  return {
    candidate_name: ctx.candidate.name,
    candidate_first_name: firstName(ctx.candidate.name),
    interviewer_name: ctx.host.name,
    event_name: ctx.eventType.name,
    organization_name: ctx.organization.name,
    date: w.date,
    time: w.time,
    timezone: w.zone,
  };
}

/** Replaces {{placeholders}} in organisation-provided copy; unknown placeholders are removed. */
export function fillTemplate(template: string, values: Record<string, string>) {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, key: string) => values[key] ?? '');
}

interface Content {
  subject: string;
  preheader: string;
  heading: string;
  intro: string;
  showDetails: boolean;
  previous?: { date: string; time: string } | null;
  notice?: string | null;
  primaryAction?: { label: string; url: string } | null;
  showCandidateActions: boolean;
  showHostDetails: boolean;
  includeCalendarLinks: boolean;
}

function content(ctx: EmailContext): Content {
  const w = when(ctx);
  const cand = ctx.recipient.kind === 'candidate';
  const prev =
    typeof ctx.metadata.previousStart === 'string' && typeof ctx.metadata.previousEnd === 'string'
      ? when(ctx, new Date(ctx.metadata.previousStart), new Date(ctx.metadata.previousEnd))
      : null;
  const reason = typeof ctx.metadata.reason === 'string' && ctx.metadata.reason ? ctx.metadata.reason : ctx.interview.cancelReason;
  const join = ctx.meeting?.joinUrl ? { label: 'Join Zoom meeting', url: ctx.meeting.joinUrl } : null;

  switch (ctx.type) {
    case 'booking_confirmation':
      return {
        subject: `Confirmed: ${ctx.eventType.name} with ${ctx.host.name} — ${w.shortDate}`,
        preheader: `${w.date}, ${w.time} ${w.zone}`,
        heading: 'Your interview is scheduled',
        intro: `Hi ${firstName(ctx.candidate.name)}, thanks for booking time with ${ctx.organization.name}. Here are the details of your ${ctx.eventType.name.toLowerCase()} with ${ctx.host.name}.`,
        showDetails: true,
        primaryAction: join,
        showCandidateActions: true,
        showHostDetails: false,
        includeCalendarLinks: true,
      };
    case 'host_booking_notification':
      return {
        subject: `New interview: ${ctx.candidate.name} — ${ctx.eventType.name}, ${w.shortDate}`,
        preheader: `${ctx.candidate.name} booked ${w.date} at ${w.time}`,
        heading: 'New interview scheduled',
        intro: `${ctx.candidate.name} (${ctx.candidate.email}) booked a ${ctx.eventType.name.toLowerCase()} with you.`,
        showDetails: true,
        primaryAction: { label: 'View interview', url: ctx.links.dashboard },
        showCandidateActions: false,
        showHostDetails: true,
        includeCalendarLinks: false,
      };
    case 'reschedule_confirmation':
      return {
        subject: `Rescheduled: ${ctx.eventType.name} — now ${w.shortDate}, ${w.time.split(' – ')[0]}`,
        preheader: `New time: ${w.date}, ${w.time}`,
        heading: 'Your interview has a new time',
        intro: `Hi ${firstName(ctx.candidate.name)}, your ${ctx.eventType.name.toLowerCase()} with ${ctx.host.name} has been moved to a new time. Your calendar invitation has been updated.`,
        showDetails: true,
        previous: prev,
        notice: reason ? `Note: ${reason}` : null,
        primaryAction: join,
        showCandidateActions: true,
        showHostDetails: false,
        includeCalendarLinks: true,
      };
    case 'host_reschedule_notification':
      return {
        subject: `Rescheduled: ${ctx.candidate.name} — ${ctx.eventType.name}, now ${w.shortDate}`,
        preheader: `New time: ${w.date}, ${w.time}`,
        heading: 'Interview rescheduled',
        intro:
          ctx.metadata.rescheduledBy === 'candidate'
            ? `${ctx.candidate.name} moved their ${ctx.eventType.name.toLowerCase()} to a new time.`
            : `The ${ctx.eventType.name.toLowerCase()} with ${ctx.candidate.name} was moved to a new time.`,
        showDetails: true,
        previous: prev,
        notice: reason ? `Reason: ${reason}` : null,
        primaryAction: { label: 'View interview', url: ctx.links.dashboard },
        showCandidateActions: false,
        showHostDetails: true,
        includeCalendarLinks: false,
      };
    case 'cancellation':
      return {
        subject: `Cancelled: ${ctx.eventType.name} on ${w.shortDate}`,
        preheader: `Your interview on ${w.date} was cancelled`,
        heading: 'Your interview was cancelled',
        intro:
          ctx.metadata.cancelledBy === 'candidate'
            ? `Hi ${firstName(ctx.candidate.name)}, this confirms that you cancelled your ${ctx.eventType.name.toLowerCase()} with ${ctx.host.name}.`
            : `Hi ${firstName(ctx.candidate.name)}, unfortunately your ${ctx.eventType.name.toLowerCase()} with ${ctx.host.name} has been cancelled.`,
        showDetails: true,
        notice: reason ? `Reason: ${reason}` : null,
        primaryAction: ctx.links.bookAgain ? { label: 'Pick a new time', url: ctx.links.bookAgain } : null,
        showCandidateActions: false,
        showHostDetails: false,
        includeCalendarLinks: false,
      };
    case 'host_cancellation_notification':
      return {
        subject: `Cancelled: ${ctx.candidate.name} — ${ctx.eventType.name}, ${w.shortDate}`,
        preheader: `The interview on ${w.date} was cancelled`,
        heading: 'Interview cancelled',
        intro:
          ctx.metadata.cancelledBy === 'candidate'
            ? `${ctx.candidate.name} cancelled their ${ctx.eventType.name.toLowerCase()}.`
            : `The ${ctx.eventType.name.toLowerCase()} with ${ctx.candidate.name} was cancelled.`,
        showDetails: true,
        notice: reason ? `Reason: ${reason}` : null,
        primaryAction: { label: 'View interview', url: ctx.links.dashboard },
        showCandidateActions: false,
        showHostDetails: true,
        includeCalendarLinks: false,
      };
    case 'reminder': {
      const offset = typeof ctx.metadata.offsetMinutes === 'number' ? formatReminderOffset(ctx.metadata.offsetMinutes) : null;
      return {
        subject: `Reminder: ${ctx.eventType.name} ${offset ? `in ${offset}` : 'coming up'} — ${w.time.split(' – ')[0]}`,
        preheader: `${w.date}, ${w.time} ${w.zone}`,
        heading: offset ? `Your interview is in ${offset}` : 'Your interview is coming up',
        intro: `Hi ${firstName(ctx.candidate.name)}, a quick reminder about your ${ctx.eventType.name.toLowerCase()} with ${ctx.host.name}.`,
        showDetails: true,
        primaryAction: join,
        showCandidateActions: true,
        showHostDetails: false,
        includeCalendarLinks: false,
      };
    }
    case 'meeting_details_update':
      return {
        subject: `Meeting link for your ${ctx.eventType.name} — ${w.shortDate}`,
        preheader: 'Your interview meeting details are ready',
        heading: 'Your meeting link is ready',
        intro: `Hi ${firstName(ctx.candidate.name)}, here is the video meeting link for your ${ctx.eventType.name.toLowerCase()} with ${ctx.host.name}. Nothing else about your interview has changed.`,
        showDetails: true,
        primaryAction: join,
        showCandidateActions: true,
        showHostDetails: false,
        includeCalendarLinks: false,
      };
  }
}

function detailRow(label: string, value: Raw | string) {
  return html`<tr>
    <td style="padding:6px 16px 6px 0;color:#667085;font-size:13px;vertical-align:top;white-space:nowrap;">${label}</td>
    <td style="padding:6px 0;color:#101828;font-size:14px;vertical-align:top;">${value}</td>
  </tr>`;
}

function button(label: string, url: string, color: string, variant: 'solid' | 'outline' = 'solid') {
  const style =
    variant === 'solid'
      ? `background:${color};color:#ffffff;border:1px solid ${color};`
      : `background:#ffffff;color:#344054;border:1px solid #d0d5dd;`;
  return html`<a href="${url}" style="display:inline-block;${raw(style)}padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;margin:0 8px 8px 0;">${label}</a>`;
}

export function renderEmail(ctx: EmailContext): RenderedEmail {
  const c = content(ctx);
  const values = placeholders(ctx);
  const subject = ctx.override?.subject ? fillTemplate(ctx.override.subject, values) : c.subject;
  const intro = ctx.override?.intro ? fillTemplate(ctx.override.intro, values) : c.intro;
  const w = when(ctx);
  const brand = /^#[0-9a-f]{6}$/i.test(ctx.organization.brandColor) ? ctx.organization.brandColor : '#0e7c66';
  const location =
    ctx.interview.locationType === 'zoom'
      ? ctx.meeting?.joinUrl
        ? html`<a href="${ctx.meeting.joinUrl}" style="color:${raw(brand)};">${ctx.meeting.joinUrl}</a>${ctx.meeting.passcode ? html`<br><span style="color:#667085;font-size:13px;">Passcode: ${ctx.meeting.passcode}</span>` : ''}`
        : html`Zoom — <span style="color:#667085;">the meeting link will be emailed to you separately.</span>`
      : html`${locationLabel(ctx.interview.locationType, ctx.interview.locationDetails)}`;

  const rows: Raw[] = [];
  if (c.showDetails) {
    rows.push(detailRow('What', `${ctx.eventType.name} (${formatDuration(ctx.eventType.durationMinutes)})`));
    rows.push(
      detailRow(
        'When',
        ctx.type === 'cancellation' || ctx.type === 'host_cancellation_notification'
          ? html`<span style="text-decoration:line-through;color:#667085;">${w.date}<br>${w.time}</span>`
          : html`<strong>${w.date}</strong><br>${w.time}`,
      ),
    );
    if (c.previous) rows.push(detailRow('Previously', html`<span style="text-decoration:line-through;color:#667085;">${c.previous.date}, ${c.previous.time}</span>`));
    rows.push(detailRow('Time zone', w.zone));
    if (ctx.recipient.kind === 'candidate') rows.push(detailRow('Interviewer', ctx.host.title ? `${ctx.host.name}, ${ctx.host.title}` : ctx.host.name));
    else rows.push(detailRow('Candidate', html`${ctx.candidate.name}<br><a href="mailto:${ctx.candidate.email}" style="color:${raw(brand)};">${ctx.candidate.email}</a>`));
    if (ctx.type !== 'cancellation' && ctx.type !== 'host_cancellation_notification') rows.push(detailRow('Where', location));
  }
  if (c.showHostDetails) {
    if (ctx.candidate.phone) rows.push(detailRow('Phone', ctx.candidate.phone));
    if (ctx.candidate.company) rows.push(detailRow('Company', ctx.candidate.company));
    if (ctx.candidate.linkedinUrl) rows.push(detailRow('LinkedIn', html`<a href="${ctx.candidate.linkedinUrl}" style="color:${raw(brand)};">${ctx.candidate.linkedinUrl}</a>`));
    if (ctx.candidate.resumeUrl) rows.push(detailRow('Résumé', html`<a href="${ctx.candidate.resumeUrl}" style="color:${raw(brand)};">Open résumé</a>`));
    for (const r of ctx.interview.responses) rows.push(detailRow(r.label, r.answer));
  }

  const actions: Raw[] = [];
  if (c.primaryAction) actions.push(button(c.primaryAction.label, c.primaryAction.url, brand));
  if (c.includeCalendarLinks && ctx.links.googleCalendar) actions.push(button('Add to Google Calendar', ctx.links.googleCalendar, brand, 'outline'));
  if (c.includeCalendarLinks && ctx.links.outlookCalendar) actions.push(button('Add to Outlook', ctx.links.outlookCalendar, brand, 'outline'));

  const manage: Raw[] = [];
  if (c.showCandidateActions) {
    if (ctx.links.view) manage.push(html`<a href="${ctx.links.view}" style="color:${raw(brand)};">View details</a>`);
    if (ctx.links.reschedule) manage.push(html`<a href="${ctx.links.reschedule}" style="color:${raw(brand)};">Reschedule</a>`);
    if (ctx.links.cancel) manage.push(html`<a href="${ctx.links.cancel}" style="color:${raw(brand)};">Cancel</a>`);
  }

  const logo = ctx.organization.logoUrl
    ? html`<img src="${ctx.organization.logoUrl}" alt="${ctx.organization.name}" height="28" style="height:28px;max-width:160px;display:block;">`
    : html`<span style="font-size:15px;font-weight:700;color:#101828;">${ctx.organization.name}</span>`;

  const body = html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${c.preheader}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;border:1px solid #eaecf0;overflow:hidden;">
<tr><td style="height:4px;background:${raw(brand)};"></td></tr>
<tr><td style="padding:28px 32px 0;">${logo}</td></tr>
<tr><td style="padding:20px 32px 0;">
<h1 style="margin:0 0 10px;font-size:22px;line-height:1.3;color:#101828;">${c.heading}</h1>
<p style="margin:0;font-size:15px;line-height:1.6;color:#344054;">${intro}</p>
${c.notice ? html`<p style="margin:14px 0 0;padding:10px 14px;background:#f9fafb;border-radius:8px;font-size:14px;color:#344054;">${c.notice}</p>` : ''}
</td></tr>
${rows.length ? html`<tr><td style="padding:20px 32px 0;"><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid #eaecf0;padding-top:12px;">${rows}</table></td></tr>` : ''}
${actions.length ? html`<tr><td style="padding:22px 32px 0;">${actions}</td></tr>` : ''}
${manage.length ? html`<tr><td style="padding:14px 32px 0;font-size:14px;color:#667085;">Need to make a change? ${raw(manage.map((m) => m.value).join(' &middot; '))}</td></tr>` : ''}
<tr><td style="padding:28px 32px 28px;font-size:12px;line-height:1.5;color:#98a2b3;border-top:1px solid #f2f4f7;margin-top:24px;">
Sent by ${ctx.organization.name} via ${raw('Calendor')}.${ctx.recipient.kind === 'candidate' ? ' Reply to this email to reach your interviewer.' : ''}
</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = [
    c.heading,
    '',
    intro,
    c.notice ? `\n${c.notice}` : '',
    '',
    c.showDetails ? `What: ${ctx.eventType.name} (${formatDuration(ctx.eventType.durationMinutes)})` : '',
    c.showDetails ? `When: ${w.date}, ${w.time}` : '',
    c.previous ? `Previously: ${c.previous.date}, ${c.previous.time}` : '',
    c.showDetails ? `Time zone: ${w.zone}` : '',
    c.showDetails && ctx.recipient.kind === 'candidate' ? `Interviewer: ${ctx.host.name}` : '',
    c.showDetails && ctx.recipient.kind === 'host' ? `Candidate: ${ctx.candidate.name} <${ctx.candidate.email}>` : '',
    c.showDetails && ctx.type !== 'cancellation' && ctx.type !== 'host_cancellation_notification'
      ? `Where: ${ctx.interview.locationType === 'zoom' ? (ctx.meeting?.joinUrl ?? 'Zoom (link to follow)') : locationLabel(ctx.interview.locationType, ctx.interview.locationDetails)}`
      : '',
    ctx.meeting?.passcode && c.showDetails ? `Passcode: ${ctx.meeting.passcode}` : '',
    ...(c.showHostDetails ? ctx.interview.responses.map((r) => `${r.label}: ${r.answer}`) : []),
    '',
    c.primaryAction ? `${c.primaryAction.label}: ${c.primaryAction.url}` : '',
    c.showCandidateActions && ctx.links.reschedule ? `Reschedule: ${ctx.links.reschedule}` : '',
    c.showCandidateActions && ctx.links.cancel ? `Cancel: ${ctx.links.cancel}` : '',
    '',
    `— ${ctx.organization.name} via Calendor`,
  ]
    .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''))
    .join('\n');

  return { subject, html: body.value, text };
}
