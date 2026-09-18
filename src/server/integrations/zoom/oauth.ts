import { zoomConfig } from '../../config/env';
import { authedRequest, oauthRequest, rawRequest } from '../http';
import { IntegrationError, type ExternalAccount, type OAuthAdapter, type OAuthTokens } from '../types';

export const ZOOM_AUTH_URL = 'https://zoom.us/oauth/authorize';
export const ZOOM_TOKEN_URL = 'https://zoom.us/oauth/token';
export const ZOOM_REVOKE_URL = 'https://zoom.us/oauth/revoke';
export const ZOOM_API = 'https://api.zoom.us/v2';

interface ZoomTokenResponse {
  access_token: string;
  token_type?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

function config() {
  const c = zoomConfig();
  if (!c) throw new IntegrationError('zoom', 'not_connected', 'Zoom OAuth is not configured on this server');
  return c;
}

function basicAuth() {
  const c = config();
  return `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}`;
}

function toTokens(res: ZoomTokenResponse): OAuthTokens {
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token ?? null,
    expiresAt: res.expires_in ? new Date(Date.now() + res.expires_in * 1000) : null,
    scopes: res.scope ? res.scope.split(/[ ,]+/).filter(Boolean) : [],
  };
}

export const zoomOAuth: OAuthAdapter = {
  provider: 'zoom',
  displayName: 'Zoom',

  isConfigured() {
    return zoomConfig() !== null;
  },

  buildAuthorizationUrl({ state, codeChallenge }) {
    const c = config();
    const url = new URL(ZOOM_AUTH_URL);
    // Zoom scopes are configured on the Marketplace app; they are not passed here.
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: c.clientId,
      redirect_uri: c.redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  },

  async exchangeCode(code, codeVerifier) {
    const c = config();
    const res = await oauthRequest<ZoomTokenResponse>(
      'zoom',
      {
        method: 'POST',
        url: ZOOM_TOKEN_URL,
        headers: { Authorization: basicAuth() },
        form: { grant_type: 'authorization_code', code, redirect_uri: c.redirectUri, code_verifier: codeVerifier },
      },
      'Zoom token exchange',
    );
    return toTokens(res);
  },

  async refreshTokens(refreshToken) {
    // Zoom rotates refresh tokens: the returned refresh token replaces the old one.
    const res = await oauthRequest<ZoomTokenResponse>(
      'zoom',
      {
        method: 'POST',
        url: ZOOM_TOKEN_URL,
        headers: { Authorization: basicAuth() },
        form: { grant_type: 'refresh_token', refresh_token: refreshToken },
      },
      'Zoom token refresh',
    );
    const tokens = toTokens(res);
    return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
  },

  async fetchAccount(accessToken): Promise<ExternalAccount> {
    const { data } = await authedRequest<{ id: string; email?: string; first_name?: string; last_name?: string; display_name?: string }>(
      'zoom',
      { get: async () => accessToken, refresh: async () => accessToken },
      { url: `${ZOOM_API}/users/me` },
      'Fetch Zoom user',
    );
    const name = data.display_name ?? ([data.first_name, data.last_name].filter(Boolean).join(' ') || null);
    return { id: data.id, email: data.email ?? null, name };
  },

  async revoke(token) {
    const res = await rawRequest('zoom', {
      method: 'POST',
      url: ZOOM_REVOKE_URL,
      headers: { Authorization: basicAuth() },
      form: { token },
    });
    if (!res.ok && res.status !== 400 && res.status !== 401) {
      throw new IntegrationError('zoom', 'transient', `Zoom token revocation failed (${res.status})`, res.status);
    }
  },
};
