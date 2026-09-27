import type { Metadata } from 'next';
import Link from 'next/link';
import { Logo } from '@/components/app/logo';
import { contactEmail } from '@/server/config/env';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'How Calendo collects, uses and protects your data, including data from Google Calendar and Zoom.',
};

const UPDATED = 'September 26, 2026';

/**
 * Linked from the OAuth consent screen, so it has to stay accurate to what the integrations actually
 * do: keep the Google section in step with src/server/integrations/google when scopes or storage change.
 */
export default function PrivacyPage() {
  const contact = contactEmail();
  return (
    <div className="min-h-screen bg-white">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/" aria-label="Calendo home">
          <Logo />
        </Link>
      </header>
      <main className="mx-auto max-w-3xl px-6 pb-20 pt-8 sm:pt-14">
        <h1 className="text-4xl font-semibold tracking-tight text-zinc-900">Privacy Policy</h1>
        <p className="mt-3 text-sm text-zinc-500">Last updated {UPDATED}</p>

        <div className="mt-10 space-y-10 text-[15px] leading-relaxed text-zinc-700 [&_h2]:mb-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-zinc-900 [&_li]:mt-1.5 [&_p+p]:mt-3 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-5">
          <section>
            <p>
              Calendo (“we”, “us”) is an interview scheduling service operated at calendo.org. This policy explains what information we collect when you use Calendo,
              how we use it, and the choices you have. Calendo is open source, so you can also read exactly how it handles data in its source code.
            </p>
          </section>

          <section>
            <h2>Information we collect</h2>
            <ul>
              <li>
                <strong>Account information</strong> — your name, email address, organization and a hashed password.
              </li>
              <li>
                <strong>Scheduling data</strong> — the event types, availability, scheduling links and interviews you create, and the details candidates enter when they
                book (name, email address, time zone and any answers you ask for).
              </li>
              <li>
                <strong>Connected accounts</strong> — when you connect Google Calendar or Zoom, the account’s ID and email address and the OAuth tokens that let Calendo act
                on your behalf. Tokens are encrypted at rest.
              </li>
              <li>
                <strong>Technical data</strong> — IP addresses and request logs used for security, rate limiting and troubleshooting, and an audit log of changes made in
                your organization.
              </li>
            </ul>
          </section>

          <section>
            <h2>Google user data</h2>
            <p>If you connect Google Calendar, Calendo requests these permissions:</p>
            <ul>
              <li>
                <strong>Your email address and basic profile</strong> — to show which Google account is connected.
              </li>
              <li>
                <strong>Read your calendars</strong> (calendar.readonly) — to list your calendars so you can choose which ones to check, to find times you are busy so
                candidates are only offered free slots, and to show your existing events next to interviews in Calendo’s calendar view.
              </li>
              <li>
                <strong>Create and manage events</strong> (calendar.events) — to add each interview to the calendar you choose, update it when the interview is
                rescheduled, and remove it when it is cancelled.
              </li>
            </ul>
            <p>
              Calendo stores the list of your calendars (name, color, time zone and your access level) and the IDs of the interview events it created. Titles, guests and
              times of your other events are read when they are needed to check availability or draw your calendar, held in memory for at most a few minutes, and never
              written to our database.
            </p>
            <p>
              We do not sell Google user data, use it for advertising, use it to train AI or machine-learning models, or share it with anyone except as needed to provide
              the features above, to comply with the law, or with your consent. Calendo’s use and transfer of information received from Google APIs adheres to the{' '}
              <a
                href="https://developers.google.com/terms/api-services-user-data-policy"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-brand-700 hover:underline"
              >
                Google API Services User Data Policy
              </a>
              , including the Limited Use requirements.
            </p>
          </section>

          <section>
            <h2>Zoom data</h2>
            <p>
              If you connect Zoom, Calendo creates, updates and deletes a meeting for each interview and stores the meeting’s ID and join link. We do not access your
              recordings, chats or other meetings.
            </p>
          </section>

          <section>
            <h2>How we use information</h2>
            <ul>
              <li>To provide scheduling: showing availability, booking interviews, and creating calendar events and video meetings.</li>
              <li>To send the emails the service depends on — confirmations, reminders, reschedules, cancellations and account emails.</li>
              <li>To keep Calendo secure, prevent abuse and fix problems.</li>
            </ul>
            <p>We do not sell personal information and do not use it for advertising.</p>
          </section>

          <section>
            <h2>Sharing</h2>
            <p>
              Interview details are shared with the people taking part in that interview. Otherwise we share data only with the service providers that run Calendo
              (hosting, database and email delivery), who process it on our behalf, and when required by law.
            </p>
          </section>

          <section>
            <h2>Retention and deletion</h2>
            <p>
              We keep your data while your account is active. Disconnecting Google Calendar or Zoom revokes Calendo’s access and deletes the stored tokens immediately; you
              can also remove Calendo’s access at any time from your Google Account’s{' '}
              <a href="https://myaccount.google.com/connections" target="_blank" rel="noopener noreferrer" className="font-medium text-brand-700 hover:underline">
                third-party connections
              </a>{' '}
              page. To delete your account and its data, email us at the address below.
            </p>
          </section>

          <section>
            <h2>Security</h2>
            <p>
              Data is sent over HTTPS, OAuth tokens are encrypted at rest, passwords are hashed, and each organization’s data is isolated from every other organization’s.
            </p>
          </section>

          <section>
            <h2>Changes</h2>
            <p>If we change this policy we will update the date above, and tell account owners by email about any significant change.</p>
          </section>

          <section>
            <h2>Contact</h2>
            <p>
              Questions or requests about your data:{' '}
              <a href={`mailto:${contact}`} className="font-medium text-brand-700 hover:underline">
                {contact}
              </a>
            </p>
          </section>
        </div>
      </main>
      <footer className="border-t border-zinc-100 py-8 text-center text-sm text-zinc-500">
        <Link href="/" className="hover:text-zinc-700">
          © {new Date().getFullYear()} CalendoX
        </Link>
      </footer>
    </div>
  );
}
