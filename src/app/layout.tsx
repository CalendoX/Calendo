import type { Metadata, Viewport } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { headers } from 'next/headers';
import { Toaster } from 'sonner';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Calendor — Interview scheduling for hiring teams', template: '%s · Calendor' },
  description: 'Schedule interviews without the back-and-forth. Calendar-aware availability, Zoom meetings and reminders for recruiters and candidates.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#0e1a17',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading request headers opts every page into dynamic rendering, which the per-request
  // CSP nonce (set in proxy.ts and applied by Next.js to its scripts) requires.
  await headers();
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen font-sans">
        {children}
        <Toaster position="bottom-right" richColors closeButton toastOptions={{ className: 'font-sans' }} />
      </body>
    </html>
  );
}
