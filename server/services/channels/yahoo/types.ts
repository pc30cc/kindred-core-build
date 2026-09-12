/**
 * Yahoo Mail channel plugin — shared types and normalized error codes.
 * Mirrors server/services/channels/gmail/types.ts's shape.
 */

export const YAHOO_ERROR_CODES = [
  'yahoo_not_configured',
  'yahoo_not_connected',
  'yahoo_invalid_state',
  'yahoo_auth_failed',
  'yahoo_token_revoked',
  'yahoo_account_already_connected',
  'yahoo_imap_error',
  'yahoo_smtp_error',
  'yahoo_timeout',
  'yahoo_network_error',
  'yahoo_provider_error',
] as const;

export type YahooErrorCode = (typeof YAHOO_ERROR_CODES)[number];

/** Human-safe messages. Never include provider payloads or credentials. */
export const YAHOO_ERROR_MESSAGES: Record<YahooErrorCode, string> = {
  yahoo_not_configured: 'Yahoo Mail integration is not configured on this platform',
  yahoo_not_connected: 'No Yahoo Mail account is connected for this workspace',
  yahoo_invalid_state: 'The Yahoo sign-in link expired or was already used — please try connecting again',
  yahoo_auth_failed: 'Authentication with Yahoo Mail failed',
  yahoo_token_revoked: 'Access to this Yahoo account was revoked — please reconnect',
  yahoo_account_already_connected: 'This Yahoo Mail account is already connected to another workspace',
  yahoo_imap_error: 'Yahoo Mail returned an IMAP error',
  yahoo_smtp_error: 'Yahoo Mail returned an SMTP error while sending',
  yahoo_timeout: 'Yahoo Mail request timed out',
  yahoo_network_error: 'Could not reach Yahoo Mail',
  yahoo_provider_error: 'Yahoo Mail returned an error',
};

export class YahooError extends Error {
  readonly code: YahooErrorCode;
  readonly detail?: string;
  constructor(code: YahooErrorCode, message?: string, detail?: string) {
    super(message || YAHOO_ERROR_MESSAGES[code]);
    this.name = 'YahooError';
    this.code = code;
    this.detail = detail;
  }
}

export function isYahooError(value: unknown): value is YahooError {
  return value instanceof YahooError;
}

export interface YahooConnectionInfo {
  connected: boolean;
  emailAddress: string | null;
  status: 'pending' | 'connected' | 'disconnected' | 'error' | null;
  lastErrorCode: string | null;
  connectedAt: string | null;
}
