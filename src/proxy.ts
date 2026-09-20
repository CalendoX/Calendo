import { NextResponse, type NextRequest } from 'next/server';

/**
 * Runs before every page request:
 *  - generates a per-request CSP nonce (scripts must carry it; no inline script injection)
 *  - optimistic auth gate: signed-out visitors to app routes go to /login?next=… (the real
 *    session check happens server-side in the (app) layout and in every API route)
 */

const APP_PREFIXES = ['/dashboard', '/interviews', '/calendar', '/event-types', '/availability', '/integrations', '/team', '/settings', '/admin', '/platform'];

function sessionCookiePresent(req: NextRequest) {
  return Boolean(req.cookies.get('__Host-slate_session')?.value || req.cookies.get('slate_session')?.value);
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (APP_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`)) && !sessionCookiePresent(request)) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV !== 'production';
  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    // Inline style attributes are used by UI libraries (positioning); scripts stay nonce-locked.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data: https:`,
    `font-src 'self' data:`,
    `connect-src 'self'${isDev ? ' ws: wss:' : ''}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico|woff2?)$).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
