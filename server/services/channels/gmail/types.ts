/**
 * Gmail channel plugin — shared types and normalized error codes.
 *
 * Mirrors `server/services/seo/gsc/types.ts`'s shape: this + `oauth.ts` +
 * `channels/mail/gmail/client.ts` are the ONLY consumption boundary for
 * Gmail/Google OAuth calls related to the email channel. Vendor SDK/HTTP
 * errors never escape past this layer.
 */

export const GMAIL_ERROR_CODES = [
  'gmail_not_configured',
  'gmail_not_connected',
  'gmail_invalid_state',
  'gmail_auth_failed',
  'gmail_token_revoked',
  'gmail_insufficient_scope',
  'gmail_account_already_connected',
  'gmail_rate_limited',
  'gmail_timeout',
  'gmail_network_error',
  'gmail_provider_error',
  'gmail_watch_failed',
] as const;

export type GmailErrorCode = (typeof GMAIL_ERROR_CODES)[number];

/** Human-safe messages. Never include provider payloads or credentials. */
export const GMAIL_ERROR_MESSAGES: Record<GmailErrorCode, string> = {
  gmail_not_configured: 'Gmail integration is not configured on this platform',
  gmail_not_connected: 'No Gmail account is connected for this workspace',
  gmail_invalid_state: 'The Google sign-in link expired or was already used — please try connecting again',
  gmail_auth_failed: 'Authentication with Gmail failed',
  gmail_token_revoked: 'Access to this Gmail account was revoked — please reconnect',
  gmail_insufficient_scope:
    'The connected Google account did not grant Gmail permission — reconnect and allow full access on the Google consent screen',
  gmail_account_already_connected: 'This Gmail account is already connected to another workspace',
  gmail_rate_limited: 'Gmail API rate limit exceeded',
  gmail_timeout: 'Gmail request timed out',
  gmail_network_error: 'Could not reach Gmail',
  gmail_provider_error: 'Gmail returned an error',
  gmail_watch_failed: 'Could not subscribe this Gmail account to inbox notifications',
};

export class GmailError extends Error {
  readonly code: GmailErrorCode;
  /** Human-readable, credential-free explanation of what actually failed. */
  readonly detail?: string;
  constructor(code: GmailErrorCode, message?: string, detail?: string) {
    super(message || GMAIL_ERROR_MESSAGES[code]);
    this.name = 'GmailError';
    this.code = code;
    this.detail = detail;
  }
}

export function isGmailError(value: unknown): value is GmailError {
  return value instanceof GmailError;
}

/**
 * The user's grant is gone: the refresh token was revoked or expired, or the
 * Gmail scope was not granted. Only a reconnect helps. Google's token
 * endpoint answers `invalid_grant` with a 400, which the client reports as a
 * provider error whose detail names that endpoint, so the detail is read too.
 * Platform-side failures (`invalid_client`, a missing config) are not this.
 */
export function isGmailGrantRevoked(err: unknown): err is GmailError {
  if (!(err instanceof GmailError)) return false;
  if (err.code === 'gmail_not_connected' || err.code === 'gmail_token_revoked' || err.code === 'gmail_insufficient_scope') return true;
  const detail = err.detail || '';
  return /oauth2\.googleapis\.com\/token/.test(detail) && /invalid_grant/.test(detail);
}

export interface GmailConnectionInfo {
  connected: boolean;
  emailAddress: string | null;
  status: 'pending' | 'connected' | 'disconnected' | 'error' | null;
  lastErrorCode: string | null;
  connectedAt: string | null;
}
