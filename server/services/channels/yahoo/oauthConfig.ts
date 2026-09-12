/**
 * Platform-level Yahoo OAuth client credentials, read directly from the
 * server environment — mirrors server/services/channels/gmail/oauthConfig.ts,
 * but Yahoo has NO existing platform OAuth Client to reuse (unlike Gmail
 * reusing GSC's Google Cloud Client): this is its own Yahoo Developer
 * Network app, with its own three env vars.
 *
 * One Yahoo app is shared by the whole platform; each WORKSPACE authorizes
 * its own Yahoo Mail account against it (see oauth.ts).
 */

export interface YahooOAuthPlatformConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

let cached: YahooOAuthPlatformConfig | null | undefined;

export function getYahooOAuthConfig(): YahooOAuthPlatformConfig | null {
  if (cached !== undefined) return cached;
  const clientId = process.env.YAHOO_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.YAHOO_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = process.env.YAHOO_OAUTH_REDIRECT_URI?.trim();
  cached = clientId && clientSecret && redirectUri ? { clientId, clientSecret, redirectUri } : null;
  return cached;
}

/** Test seam: forget the memoized config. */
export function resetYahooOAuthConfigCache(): void {
  cached = undefined;
}

export function isYahooPlatformConfigured(): boolean {
  return getYahooOAuthConfig() !== null;
}

/**
 * Granular, secret-free view of the Yahoo env setup — mirrors
 * gmail/oauthConfig.ts's getGmailPlatformEnvStatus(), for the Super Admin
 * plugin page.
 */
export interface YahooPlatformEnvStatus {
  yahooOAuthClientConfigured: boolean; // YAHOO_OAUTH_CLIENT_ID + YAHOO_OAUTH_CLIENT_SECRET
  yahooRedirectUriConfigured: boolean; // YAHOO_OAUTH_REDIRECT_URI
  fullyConfigured: boolean;
}

export function getYahooPlatformEnvStatus(): YahooPlatformEnvStatus {
  const yahooOAuthClientConfigured =
    !!process.env.YAHOO_OAUTH_CLIENT_ID?.trim() && !!process.env.YAHOO_OAUTH_CLIENT_SECRET?.trim();
  const yahooRedirectUriConfigured = !!process.env.YAHOO_OAUTH_REDIRECT_URI?.trim();
  return {
    yahooOAuthClientConfigured,
    yahooRedirectUriConfigured,
    fullyConfigured: yahooOAuthClientConfigured && yahooRedirectUriConfigured,
  };
}
