/**
 * Gmail channel plugin — shared types and normalized error codes.
 *
 * Mirrors `server/services/seo/gsc/types.ts`'s shape: this + `oauth.ts` +
 * `channels/providers/gmail/client.ts` are the ONLY consumption boundary for
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

export interface GmailConnectionInfo {
  connected: boolean;
  emailAddress: string | null;
  status: 'pending' | 'connected' | 'disconnected' | 'error' | null;
  lastErrorCode: string | null;
  connectedAt: string | null;
}
