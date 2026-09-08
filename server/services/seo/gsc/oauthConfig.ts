/**
 * Platform-level Google OAuth client credentials, read directly from the
 * server environment — mirrors server/services/push/fcm.ts's
 * getFcmCredentials() precedent for an optional third-party integration
 * that isn't part of the strict ServerConfig contract (server/config.ts):
 * this is a deployment-optional integration, not a security boundary
 * between Core services, so it doesn't need config.ts's cross-secret
 * distinctness checks.
 *
 * One Google Cloud OAuth 2.0 Client (Web application type) is shared by the
 * whole platform; each WORKSPACE authorizes its own Google Search Console
 * account against it (see index.ts) — the client id/secret below are never
 * workspace-specific and never leave this process.
 */

export interface GoogleOAuthPlatformConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

let cached: GoogleOAuthPlatformConfig | null | undefined;

export function getGoogleOAuthConfig(): GoogleOAuthPlatformConfig | null {
  if (cached !== undefined) return cached;
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  cached = clientId && clientSecret && redirectUri ? { clientId, clientSecret, redirectUri } : null;
  return cached;
}

/** Test seam: forget the memoized config. */
export function resetGoogleOAuthConfigCache(): void {
  cached = undefined;
}
