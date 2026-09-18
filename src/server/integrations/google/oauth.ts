import { googleConfig } from '../../config/env';
import { oauthRequest, rawRequest } from '../http';
import { IntegrationError, type ExternalAccount, type OAuthAdapter, type OAuthTokens } from '../types';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

/**
 * Least-privilege scopes: read calendars + free/busy (conflict detection) and manage events
 * (create/update/cancel interview events). `openid email` identifies the connected account.
 */
export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

interface GoogleTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
}

function config() {
  const c = googleConfig();
  if (!c) throw new IntegrationError('google_calendar', 'not_connected', 'Google OAuth is not configured on this server');
  return c;
}

function toTokens(res: GoogleTokenResponse): OAuthTokens {
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token ?? null,
    expiresAt: res.expires_in ? new Date(Date.now() + res.expires_in * 1000) : null,
    scopes: res.scope ? res.scope.split(' ') : [],
  };
}

export const googleOAuth: OAuthAdapter = {
  provider: 'google_calendar',
  displayName: 'Google Calendar',

  isConfigured() {
    return googleConfig() !== null;
  },

  buildAuthorizationUrl({ state, codeChallenge }) {
    const c = config();
    const url = new URL(GOOGLE_AUTH_URL);
    url.search = new URLSearchParams({
      client_id: c.clientId,
      redirect_uri: c.redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      // offline + consent guarantees a refresh token is issued.
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  },

  async exchangeCode(code, codeVerifier) {
    const c = config();
    const res = await oauthRequest<GoogleTokenResponse>(
      'google_calendar',
      {
        method: 'POST',
        url: GOOGLE_TOKEN_URL,
        form: {
          code,
          client_id: c.clientId,
          client_secret: c.clientSecret,
          redirect_uri: c.redirectUri,
          grant_type: 'authorization_code',
          code_verifier: codeVerifier,
        },
      },
      'Google token exchange',
    );
    return toTokens(res);
  },

  async refreshTokens(refreshToken) {
    const c = config();
    const res = await oauthRequest<GoogleTokenResponse>(
      'google_calendar',
      {
        method: 'POST',
        url: GOOGLE_TOKEN_URL,
        form: {
          refresh_token: refreshToken,
          client_id: c.clientId,
          client_secret: c.clientSecret,
          grant_type: 'refresh_token',
        },
      },
      'Google token refresh',
    );
    const tokens = toTokens(res);
    // Google normally does not rotate refresh tokens; keep the existing one.
    return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
  },

  async fetchAccount(accessToken): Promise<ExternalAccount> {
    const res = await rawRequest('google_calendar', {
      url: GOOGLE_USERINFO_URL,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new IntegrationError('google_calendar', res.status === 401 ? 'auth' : 'transient', `Google userinfo failed (${res.status})`, res.status);
    }
    const data = (await res.json()) as { sub: string; email?: string; name?: string };
    return { id: data.sub, email: data.email ?? null, name: data.name ?? null };
  },

  async revoke(token) {
    const res = await rawRequest('google_calendar', { method: 'POST', url: GOOGLE_REVOKE_URL, form: { token } });
    // 400 invalid_token means it was already revoked — fine.
    if (!res.ok && res.status !== 400) {
      throw new IntegrationError('google_calendar', 'transient', `Google token revocation failed (${res.status})`, res.status);
    }
  },
};
