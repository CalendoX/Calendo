import nodemailer from 'nodemailer';
import { env } from '../config/env';

/**
 * Transactional email transport. Select with EMAIL_PROVIDER:
 *   smtp        — any SMTP server (Postmark, SES, SendGrid, Mailgun, Mailpit in development)
 *   resend      — Resend HTTP API
 *   cloudflare  — Cloudflare Email Service REST API (the sender's domain must be onboarded for sending)
 *   console     — log emails to stdout (development / CI only)
 */

export interface EmailAttachment {
  filename: string;
  content: string;
  contentType: string;
}

export interface EmailMessage {
  to: { email: string; name?: string | null };
  /** Sender address; defaults to the platform sender (EMAIL_FROM), e.g. an organisation's verified domain. */
  from?: { name: string; address: string };
  fromName?: string;
  replyTo?: string | null;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
  /** Calendar invitation (text/calendar) sent as an alternative part so clients show RSVP UI. */
  icalEvent?: { method: 'REQUEST' | 'CANCEL'; content: string };
  headers?: Record<string, string>;
}

/** The provider refused the sender address (e.g. its domain is no longer verified). */
export class SenderDomainRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SenderDomainRejectedError';
  }
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<{ messageId: string | null }>;
}

/** The platform-wide sender (EMAIL_FROM), used unless an organisation has verified its own domain. */
export function platformSender(): { name: string; address: string } {
  const raw = env().EMAIL_FROM;
  const match = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(raw);
  if (match) return { name: match[1].trim(), address: match[2].trim() };
  return { name: env().APP_NAME, address: raw.trim() };
}

function formatAddress(name: string, address: string) {
  return `"${name.replace(/["\\\r\n]/g, '')}" <${address}>`;
}

class SmtpProvider implements EmailProvider {
  readonly name = 'smtp';
  private transport = nodemailer.createTransport({
    host: env().SMTP_HOST,
    port: env().SMTP_PORT,
    secure: env().SMTP_SECURE,
    auth: env().SMTP_USER ? { user: env().SMTP_USER!, pass: env().SMTP_PASSWORD ?? '' } : undefined,
    pool: true,
    maxConnections: 3,
    connectionTimeout: 10_000,
    socketTimeout: 20_000,
  });

  async send(m: EmailMessage) {
    const from = m.from ?? platformSender();
    const info = await this.transport.sendMail({
      from: formatAddress(m.fromName ?? from.name, from.address),
      to: m.to.name ? formatAddress(m.to.name, m.to.email) : m.to.email,
      replyTo: m.replyTo ?? env().EMAIL_REPLY_TO ?? undefined,
      subject: m.subject,
      html: m.html,
      text: m.text,
      headers: m.headers,
      icalEvent: m.icalEvent ? { method: m.icalEvent.method, content: m.icalEvent.content, filename: 'invite.ics' } : undefined,
      attachments: m.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    });
    return { messageId: info.messageId ?? null };
  }
}

class ResendProvider implements EmailProvider {
  readonly name = 'resend';
  async send(m: EmailMessage) {
    const from = m.from ?? platformSender();
    const attachments = [...(m.attachments ?? [])];
    if (m.icalEvent) attachments.push({ filename: 'invite.ics', content: m.icalEvent.content, contentType: `text/calendar; method=${m.icalEvent.method}` });
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env().RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: formatAddress(m.fromName ?? from.name, from.address),
        to: [m.to.email],
        reply_to: m.replyTo ?? env().EMAIL_REPLY_TO ?? undefined,
        subject: m.subject,
        html: m.html,
        text: m.text,
        headers: m.headers,
        attachments: attachments.map((a) => ({
          filename: a.filename,
          content: Buffer.from(a.content).toString('base64'),
          content_type: a.contentType,
        })),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (res.status === 403 && m.from && /domain/i.test(body.message ?? '')) throw new SenderDomainRejectedError(`Resend refused the sender ${m.from.address}: ${body.message}`);
    if (!res.ok) throw new Error(`Resend API error ${res.status}: ${body.message ?? 'unknown error'}`);
    return { messageId: body.id ?? null };
  }
}

interface CloudflareSendResponse {
  success?: boolean;
  errors?: { code: number; message: string }[];
  result?: { delivered: string[]; permanent_bounces: string[]; queued: string[] } | null;
}

/** https://developers.cloudflare.com/email-service/api/send-emails/rest-api/ */
class CloudflareProvider implements EmailProvider {
  readonly name = 'cloudflare';
  async send(m: EmailMessage) {
    const from = m.from ?? platformSender();
    const attachments = [...(m.attachments ?? [])];
    if (m.icalEvent) attachments.push({ filename: 'invite.ics', content: m.icalEvent.content, contentType: `text/calendar; method=${m.icalEvent.method}` });
    const replyTo = m.replyTo ?? env().EMAIL_REPLY_TO;
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env().CLOUDFLARE_ACCOUNT_ID!)}/email/sending/send`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env().CLOUDFLARE_EMAIL_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: { address: from.address, name: (m.fromName ?? from.name).replace(/["\\\r\n]/g, '') },
          to: m.to.email,
          ...(replyTo ? { reply_to: replyTo } : {}),
          subject: m.subject,
          html: m.html,
          text: m.text,
          ...(m.headers ? { headers: m.headers } : {}),
          ...(attachments.length
            ? {
                attachments: attachments.map((a) => ({
                  filename: a.filename,
                  content: Buffer.from(a.content).toString('base64'),
                  type: a.contentType,
                  disposition: 'attachment',
                })),
              }
            : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const body = (await res.json().catch(() => ({}))) as CloudflareSendResponse;
    if (!res.ok || !body.success) {
      const detail = body.errors?.map((e) => `${e.code} ${e.message}`).join('; ') || 'unknown error';
      throw new Error(`Cloudflare Email Service error ${res.status}: ${detail}`);
    }
    if (body.result?.permanent_bounces.includes(m.to.email)) {
      throw new Error(`Cloudflare Email Service: ${m.to.email} bounced permanently`);
    }
    return { messageId: null };
  }
}

class ConsoleProvider implements EmailProvider {
  readonly name = 'console';
  async send(m: EmailMessage) {
    console.info(`[email] To: ${m.to.email}\n[email] Subject: ${m.subject}\n${m.text}\n[email] ---`);
    return { messageId: `console-${Date.now()}` };
  }
}

let provider: EmailProvider | null = null;
let override: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (override) return override;
  if (!provider) {
    switch (env().EMAIL_PROVIDER) {
      case 'smtp':
        provider = new SmtpProvider();
        break;
      case 'resend':
        provider = new ResendProvider();
        break;
      case 'cloudflare':
        provider = new CloudflareProvider();
        break;
      default:
        provider = new ConsoleProvider();
    }
  }
  return provider;
}

/** Test hook. */
export function setEmailProviderOverride(p: EmailProvider | null) {
  override = p;
}
