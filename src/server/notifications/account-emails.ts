import { env } from '../config/env';
import { decrypt } from '../security/crypto';
import { getEmailProvider } from './email-provider';
import { escapeHtml } from './templates';
import type { JobPayloads } from '../jobs/definitions';

/** Account lifecycle emails (verification, password reset, invitations). */

type Payload = JobPayloads['account-email'];

function layout(heading: string, body: string, cta: { label: string; url: string }, footnote: string) {
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border:1px solid #eaecf0;border-radius:14px;">
<tr><td style="padding:28px 32px 0;font-size:15px;font-weight:700;color:#101828;">${escapeHtml(env().APP_NAME)}</td></tr>
<tr><td style="padding:16px 32px 0;"><h1 style="margin:0 0 10px;font-size:21px;color:#101828;">${escapeHtml(heading)}</h1>
<p style="margin:0;font-size:15px;line-height:1.6;color:#344054;">${body}</p></td></tr>
<tr><td style="padding:22px 32px 0;"><a href="${escapeHtml(cta.url)}" style="display:inline-block;background:#0e7c66;color:#fff;padding:11px 20px;border-radius:8px;font-weight:600;font-size:14px;text-decoration:none;">${escapeHtml(cta.label)}</a></td></tr>
<tr><td style="padding:18px 32px 28px;font-size:12px;line-height:1.5;color:#98a2b3;">${escapeHtml(footnote)}<br>If the button doesn't work, paste this link into your browser:<br><span style="word-break:break-all;">${escapeHtml(cta.url)}</span></td></tr>
</table></td></tr></table></body></html>`;
  return html;
}

export async function sendAccountEmail(p: Payload) {
  const url = decrypt(p.encryptedUrl);
  let subject: string;
  let html: string;
  let text: string;
  switch (p.kind) {
    case 'verify_email':
      subject = `Verify your email for ${env().APP_NAME}`;
      html = layout(
        'Confirm your email address',
        `Hi ${escapeHtml(p.name)}, please confirm this is your email address so candidates can book interviews with you.`,
        { label: 'Verify email', url },
        'This link expires in 48 hours.',
      );
      text = `Hi ${p.name},\n\nConfirm your email address: ${url}\n\nThis link expires in 48 hours.`;
      break;
    case 'password_reset':
      subject = `Reset your ${env().APP_NAME} password`;
      html = layout(
        'Reset your password',
        `Hi ${escapeHtml(p.name)}, we received a request to reset your password. If you didn't request this, you can safely ignore this email.`,
        { label: 'Choose a new password', url },
        'This link expires in 1 hour and can be used once.',
      );
      text = `Hi ${p.name},\n\nReset your password: ${url}\n\nThis link expires in 1 hour. If you didn't request it, ignore this email.`;
      break;
    case 'invitation':
      subject = `${p.inviterName ?? 'Your team'} invited you to ${p.organizationName ?? env().APP_NAME} on ${env().APP_NAME}`;
      html = layout(
        `Join ${p.organizationName ?? 'your team'}`,
        `Hi ${escapeHtml(p.name)}, ${escapeHtml(p.inviterName ?? 'a teammate')} invited you to schedule interviews with ${escapeHtml(p.organizationName ?? 'their team')}. Set your password to get started.`,
        { label: 'Accept invitation', url },
        'This invitation expires in 7 days.',
      );
      text = `Hi ${p.name},\n\n${p.inviterName ?? 'A teammate'} invited you to ${p.organizationName ?? env().APP_NAME}. Accept: ${url}\n\nThis invitation expires in 7 days.`;
      break;
  }
  await getEmailProvider().send({ to: { email: p.to, name: p.name }, subject, html, text });
}
