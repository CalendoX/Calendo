import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

if (process.env.NODE_ENV === 'production') {
  securityHeaders.push({ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' });
}

// The dev server only trusts localhost by default; also trust the host the app is served from
// (e.g. a server IP), so dev assets and live reload work when opened at APP_URL.
function appHostname() {
  try {
    return new URL(process.env.APP_URL ?? '').hostname;
  } catch {
    return null;
  }
}
const appHost = appHostname();

const nextConfig: NextConfig = {
  poweredByHeader: false,
  allowedDevOrigins: appHost && appHost !== 'localhost' ? [appHost] : [],
  output: 'standalone',
  serverExternalPackages: ['pg', 'pg-boss', '@node-rs/argon2', 'nodemailer'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
