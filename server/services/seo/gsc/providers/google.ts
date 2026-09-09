/**
 * GOOGLE SEARCH CONSOLE / OAUTH ADAPTER
 *
 * The ONLY place in the codebase that talks to Google's OAuth and Search
 * Console (Webmasters v3) APIs. Every call is fail-closed: HTTP errors,
 * malformed JSON, and timeouts all resolve to a normalized `GscError`. No
 * credential (client secret, refresh token, access token) is ever placed in
 * an error message, log line or return value.
 *
 * FIELD-MAPPING NOTE: written against the long-stable OAuth 2.0 token
 * endpoint and Search Console API v3 response envelopes. It could not be
 * verified against a live response from this environment (network policy
 * blocks outbound calls to Google's API from this sandbox), so parsing is
 * deliberately defensive — unknown/missing fields fall back to null/empty
 * rather than throwing. Re-verify field names against a real response on
 * first live test.
 */
import { GscError } from '../types.js';

export const GSC_TIMEOUT_MS = 20_000;
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
export const WEBMASTERS_API_BASE = 'https://www.googleapis.com/webmasters/v3';

export const GSC_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'openid',
  'email',
].join(' ');

export interface GoogleAdapterOptions {
  /** Test seam — injects a fake fetch. Production leaves this undefined. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface GoogleTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  scope: string | null;
}

export interface GoogleSiteEntry {
  siteUrl: string;
  permissionLevel: string | null;
}

async function requestJson(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    if (res.status === 401 || res.status === 403) {
      let body: any = null;
      try { body = await res.json(); } catch { /* ignore */ }
      // Two different Google error envelopes share this 401/403 branch:
      //   - OAuth token endpoint (oauth2.googleapis.com/token): flat
      //     { error: "invalid_grant", error_description: "..." }.
      //   - Every resource API (Search Console, userinfo, ...) — including
      //     the case that actually reaches here most often, an access token
      //     that's technically valid but the call is rejected anyway (the
      //     Search Console API not enabled on the Cloud project, the
      //     connected account lacking a verified property, a scope the
      //     consent screen never actually granted): a structured
      //     { error: { code, message, status, errors: [...] } } object,
      //     which the flat check below can never match — so this whole
      //     class of failure always fell through to the same generic
      //     gsc_auth_failed with nothing logged, indistinguishable from an
      //     actually-bad token.
      const flatReason = typeof body?.error === 'string' ? body.error : '';
      const structuredMessage = typeof body?.error?.message === 'string' ? body.error.message : null;
      const structuredStatus = typeof body?.error?.status === 'string' ? body.error.status : null;
      if (flatReason === 'invalid_grant') throw new GscError('gsc_token_revoked');
      console.error(
        `[gsc] ${url} returned ${res.status}: ${structuredMessage || structuredStatus || flatReason || '(no error detail in response body)'}`,
      );
      throw new GscError('gsc_auth_failed');
    }
    if (res.status === 429) throw new GscError('gsc_rate_limited');
    if (!res.ok) throw new GscError('gsc_provider_error');
    try {
      return await res.json();
    } catch {
      throw new GscError('gsc_provider_error');
    }
  } catch (err) {
    if (err instanceof GscError) throw err;
    if ((err as { name?: string })?.name === 'AbortError') throw new GscError('gsc_timeout');
    throw new GscError('gsc_network_error');
  } finally {
    clearTimeout(timer);
  }
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function buildGoogleAuthUrl(config: GoogleOAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: GSC_OAUTH_SCOPES,
    access_type: 'offline',
    // Forces Google to re-issue a refresh_token even on a reconnect — without
    // this, a user reconnecting after revoking access from their Google
    // Account settings would get an access_token but no refresh_token back.
    prompt: 'consent',
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export function createGoogleAdapter(config: GoogleOAuthConfig, options: GoogleAdapterOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? GSC_TIMEOUT_MS;

  async function exchangeCodeForTokens(code: string): Promise<GoogleTokenResponse> {
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: config.redirectUri,
    });
    const json = (await requestJson(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, fetchImpl, timeoutMs)) as Record<string, unknown>;
    const accessToken = typeof json.access_token === 'string' ? json.access_token : null;
    if (!accessToken) throw new GscError('gsc_auth_failed');
    return {
      accessToken,
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
      expiresInSeconds: typeof json.expires_in === 'number' ? json.expires_in : 3600,
      scope: typeof json.scope === 'string' ? json.scope : null,
    };
  }

  async function refreshAccessToken(refreshToken: string): Promise<GoogleTokenResponse> {
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const json = (await requestJson(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, fetchImpl, timeoutMs)) as Record<string, unknown>;
    const accessToken = typeof json.access_token === 'string' ? json.access_token : null;
    if (!accessToken) throw new GscError('gsc_auth_failed');
    return {
      accessToken,
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
      expiresInSeconds: typeof json.expires_in === 'number' ? json.expires_in : 3600,
      scope: typeof json.scope === 'string' ? json.scope : null,
    };
  }

  async function revokeToken(token: string): Promise<void> {
    try {
      await fetchImpl(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' });
    } catch {
      // Best-effort: the local connection row is deleted regardless of
      // whether Google's revoke endpoint could be reached.
    }
  }

  async function fetchAccountEmail(accessToken: string): Promise<string | null> {
    try {
      const json = (await requestJson(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }, fetchImpl, timeoutMs)) as Record<string, unknown>;
      return typeof json.email === 'string' ? json.email : null;
    } catch {
      return null;
    }
  }

  async function listSites(accessToken: string): Promise<GoogleSiteEntry[]> {
    const json = (await requestJson(`${WEBMASTERS_API_BASE}/sites`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }, fetchImpl, timeoutMs)) as Record<string, unknown>;
    const entries = Array.isArray(json.siteEntry) ? json.siteEntry : [];
    return entries
      .filter((e): e is Record<string, unknown> => e && typeof e === 'object')
      .map((e) => ({
        siteUrl: typeof e.siteUrl === 'string' ? e.siteUrl : '',
        permissionLevel: typeof e.permissionLevel === 'string' ? e.permissionLevel : null,
      }))
      .filter((e) => e.siteUrl !== '');
  }

  async function querySearchAnalytics(
    accessToken: string,
    siteUrl: string,
    body: { startDate: string; endDate: string; dimensions: string[]; rowLimit: number; startRow: number },
  ): Promise<{ rows: Array<{ keys: string[]; clicks: number; impressions: number; ctr: number; position: number }>; responseAggregationType: string | null }> {
    const json = (await requestJson(
      `${WEBMASTERS_API_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      fetchImpl,
      timeoutMs,
    )) as Record<string, unknown>;
    const rawRows = Array.isArray(json.rows) ? json.rows : [];
    const rows = rawRows
      .filter((r): r is Record<string, unknown> => r && typeof r === 'object')
      .map((r) => ({
        keys: Array.isArray(r.keys) ? r.keys.map((k) => String(k)) : [],
        clicks: typeof r.clicks === 'number' ? r.clicks : 0,
        impressions: typeof r.impressions === 'number' ? r.impressions : 0,
        ctr: typeof r.ctr === 'number' ? r.ctr : 0,
        position: typeof r.position === 'number' ? r.position : 0,
      }));
    return {
      rows,
      responseAggregationType: typeof json.responseAggregationType === 'string' ? json.responseAggregationType : null,
    };
  }

  return { exchangeCodeForTokens, refreshAccessToken, revokeToken, fetchAccountEmail, listSites, querySearchAnalytics };
}

export type GoogleAdapter = ReturnType<typeof createGoogleAdapter>;
