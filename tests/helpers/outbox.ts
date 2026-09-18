import type { EmailMessage, EmailProvider } from '../../src/server/notifications/email-provider';

/** Email provider that records messages instead of sending them. */
class Outbox implements EmailProvider {
  readonly name = 'test-outbox';
  messages: EmailMessage[] = [];
  /** When set, the next `failures` sends throw (to exercise retry handling). */
  private failures = 0;

  async send(message: EmailMessage) {
    if (this.failures > 0) {
      this.failures--;
      throw new Error('SMTP connection refused (simulated)');
    }
    this.messages.push(message);
    return { messageId: `test-${this.messages.length}` };
  }

  failNext(count = 1) {
    this.failures = count;
  }

  to(email: string) {
    return this.messages.filter((m) => m.to.email === email);
  }

  clear() {
    this.messages = [];
    this.failures = 0;
  }
}

export const outbox = new Outbox();
