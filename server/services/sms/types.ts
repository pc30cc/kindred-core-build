/**
 * SMS SERVICE — shared types and normalized error codes.
 *
 * The SMS service is the ONLY consumption boundary for SMS in the backend.
 * Provider SDK errors never escape past this layer: they are mapped to the
 * closed union of `SmsErrorCode` below so no raw SDK object, stack trace or
 * credential can reach an HTTP response or a log line.
 */

export const SMS_ERROR_CODES = [
  'sms_provider_not_configured',
  'sms_provider_disabled',
  'sms_auth_failed',
  'sms_insufficient_credit',
  'sms_invalid_receptor',
  'sms_template_not_found',
  'sms_template_not_approved',
  'sms_template_invalid',
  'sms_provider_feature_unavailable',
  'sms_timeout',
  'sms_network_error',
  'sms_provider_error',
] as const;

export type SmsErrorCode = (typeof SMS_ERROR_CODES)[number];

/** Human-safe messages. Never include provider payloads or credentials. */
export const SMS_ERROR_MESSAGES: Record<SmsErrorCode, string> = {
  sms_provider_not_configured: 'SMS provider is not configured',
  sms_provider_disabled: 'SMS provider is disabled',
  sms_auth_failed: 'Authentication failed',
  sms_insufficient_credit: 'Insufficient account credit',
  sms_invalid_receptor: 'Invalid recipient number',
  sms_template_not_found: 'Verification template not found',
  sms_template_not_approved: 'Verification template is not approved',
  sms_template_invalid: 'Verification template is invalid',
  sms_provider_feature_unavailable: 'Requested feature is unavailable on this account',
  sms_timeout: 'SMS provider request timed out',
  sms_network_error: 'Could not reach the SMS provider',
  sms_provider_error: 'SMS provider returned an error',
};

export class SmsError extends Error {
  readonly code: SmsErrorCode;

  constructor(code: SmsErrorCode) {
    super(SMS_ERROR_MESSAGES[code]);
    this.name = 'SmsError';
    this.code = code;
  }
}

export function isSmsError(value: unknown): value is SmsError {
  return value instanceof SmsError;
}

/** Vendors that have a real runtime adapter in this phase. */
export const SUPPORTED_SMS_PROVIDERS = ['kavenegar', 'smsir', 'telnyx'] as const;
export type SupportedSmsProvider = (typeof SUPPORTED_SMS_PROVIDERS)[number];

/** Values accepted by the `provider_name` column. */
export const SMS_PROVIDER_NAMES = ['kavenegar', 'smsir', 'telnyx', 'disabled'] as const;
export type SmsProviderName = (typeof SMS_PROVIDER_NAMES)[number];

export interface KavenegarSmsConfig {
  provider: 'kavenegar';
  apiKey: string;
  verifyTemplate: string;
  sender?: string;
}

export interface SmsIrSmsConfig {
  provider: 'smsir';
  apiKey: string;
  /** Stored as a string so long line numbers keep full precision. */
  lineNumber: string;
  verifyTemplateId: number;
  verifyParameterName: string;
}

/** How Telnyx Verify delivers the code: a text message or a voice call. */
export const TELNYX_CHANNELS = ['sms', 'call'] as const;
export type TelnyxChannel = (typeof TELNYX_CHANNELS)[number];

/**
 * Telnyx Verify (International edition). The code is ours (`custom_code`):
 * Telnyx only delivers it, worded by the Verify Profile's own template.
 */
export interface TelnyxSmsConfig {
  provider: 'telnyx';
  apiKey: string;
  /** The Verify Profile (a UUID) whose template and sender carry the code. */
  verifyProfileId: string;
  channel: TelnyxChannel;
}

/** Discriminated union of every runtime SMS configuration. */
export type SmsProviderConfig = KavenegarSmsConfig | SmsIrSmsConfig | TelnyxSmsConfig;

export interface SmsSendRequest {
  to: string;
  body: string;
  sender?: string;
}

export interface SmsVerificationRequest {
  to: string;
  code: string;
  template?: string;
  /**
   * How long the code stays valid, in seconds. Telnyx is told the same
   * lifetime (`timeout_secs`); the Iranian vendors ignore it.
   */
  ttlSeconds?: number;
}

export interface SmsSendResult {
  success: boolean;
  provider: string;
  messageId?: string;
  errorCode?: SmsErrorCode;
}

/** Redacted view of the stored config. NEVER carries the credential. */
export interface SmsProviderInfo {
  providerName: SmsProviderName;
  configured: boolean;
  enabled: boolean;
  hasApiKey: boolean;
  sender: string | null;
  verifyTemplate: string | null;
  lineNumber: string | null;
  verifyTemplateId: number | null;
  verifyParameterName: string | null;
  /** Telnyx only. */
  verifyProfileId: string | null;
  /** Telnyx only: 'sms' or 'call'. */
  channel: TelnyxChannel | null;
  updatedAt: string | null;
}

export interface SmsAccountInfo {
  balance: number | null;
  currency: string;
  accountType: string | null;
  /** Telnyx: the name of the configured Verify Profile. */
  profileName?: string | null;
}

export interface SmsTestResult {
  success: boolean;
  provider: string;
  latencyMs: number;
  balance?: number | null;
  currency?: string;
  accountType?: string | null;
  profileName?: string | null;
  error?: string;
  errorCode?: SmsErrorCode;
}

/**
 * Mask a phone number for logging: keep the leading country digits and the
 * final two digits only — e.g. `+98912*****67`.
 */
export function maskPhone(raw: string): string {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  const plus = value.startsWith('+');
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return `${plus ? '+' : ''}${'*'.repeat(digits.length)}`;
  const head = digits.slice(0, Math.min(5, digits.length - 2));
  const tail = digits.slice(-2);
  const hidden = digits.length - head.length - tail.length;
  return `${plus ? '+' : ''}${head}${'*'.repeat(hidden)}${tail}`;
}