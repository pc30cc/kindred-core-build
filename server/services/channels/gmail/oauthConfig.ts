/**
 * Gmail-specific slice of the platform's Google OAuth client configuration.
 *
 * Deliberately reuses the SAME Google Cloud OAuth 2.0 Client (Web
 * application type) already configured for Search Console
 * (`GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET` —
 * `server/services/seo/gsc/oauthConfig.ts`): Google allows multiple
 * redirect URIs per OAuth Client, so connecting Gmail only needs one more
 * URI added to the Client the operator already created for GSC, not a
 * second Google Cloud project. Only the redirect URI is Gmail-specific.
 */

export interface GmailOAuthPlatformConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

let cached: GmailOAuthPlatformConfig | null | undefined;

export function getGmailOAuthConfig(): GmailOAuthPlatformConfig | null {
  if (cached !== undefined) return cached;
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GOOGLE_GMAIL_OAUTH_REDIRECT_URI?.trim();
  cached = clientId && clientSecret && redirectUri ? { clientId, clientSecret, redirectUri } : null;
  return cached;
}

/** Test seam: forget the memoized config. */
export function resetGmailOAuthConfigCache(): void {
  cached = undefined;
}

/**
 * Granular, secret-free view of the Gmail env setup — for the Super Admin
 * plugin page, which needs to tell an operator WHICH of the several
 * required vars is still missing, not just an overall yes/no the way
 * `getGmailOAuthConfig()` collapses it to. Never returns a secret value,
 * only whether each one is present.
 */
export interface GmailPlatformEnvStatus {
  googleOAuthClientConfigured: boolean; // GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET (shared with GSC)
  gmailRedirectUriConfigured: boolean; // GOOGLE_GMAIL_OAUTH_REDIRECT_URI
  pubsubTopicConfigured: boolean; // GMAIL_PUBSUB_TOPIC
  pubsubPushAudienceConfigured: boolean; // GMAIL_PUBSUB_PUSH_AUDIENCE
  fullyConfigured: boolean;
}

export function getGmailPlatformEnvStatus(): GmailPlatformEnvStatus {
  const googleOAuthClientConfigured =
    !!process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() && !!process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const gmailRedirectUriConfigured = !!process.env.GOOGLE_GMAIL_OAUTH_REDIRECT_URI?.trim();
  const pubsubTopicConfigured = !!process.env.GMAIL_PUBSUB_TOPIC?.trim();
  const pubsubPushAudienceConfigured = !!process.env.GMAIL_PUBSUB_PUSH_AUDIENCE?.trim();
  return {
    googleOAuthClientConfigured,
    gmailRedirectUriConfigured,
    pubsubTopicConfigured,
    pubsubPushAudienceConfigured,
    fullyConfigured:
      googleOAuthClientConfigured && gmailRedirectUriConfigured && pubsubTopicConfigured && pubsubPushAudienceConfigured,
  };
}
