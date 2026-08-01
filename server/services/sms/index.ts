/**
 * SMS SERVICE
 *
 * The single consumption boundary for SMS in the backend.
 *
 * Storage: `public.platform_sms_provider_config` — a service-role-only table.
 * The credential lives there and is read ONLY by this module through the
 * service client. It is never returned to the browser and never logged.
 *
 * Resolution (this phase): the single active platform-level config.
 * Workspace overrides are intentionally NOT consulted: phone verification is a
 * platform-level security capability, not a per-workspace messaging feature.
 * The adapter registry below is the extension point for future vendors.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import {
  SmsError,
  maskPhone,
  SMS_PROVIDER_NAMES,
  SUPPORTED_SMS_PROVIDERS,
  type KavenegarSmsConfig,
  type SmsIrSmsConfig,
  type SmsProviderInfo,
  type SmsProviderName,
  type SmsSendRequest,
  type SmsSendResult,
  type SmsTestResult,
  type SmsVerificationRequest,
} from './types.js';
import {
  createKavenegarAdapter,
  type KavenegarAdapter,
  type KavenegarAdapterOptions,
} from './providers/kavenegar.js';
import {
  createSmsIrAdapter,
  isValidSmsIrLineNumber,
  isValidSmsIrParameterName,
  isValidSmsIrTemplateId,
  type SmsIrAdapter,
  type SmsIrAdapterOptions,
} from './providers/smsir.js';

const TABLE = 'platform_sms_provider_config';

/** Kavenegar template names: letters and digits only, no space/underscore. */
export const VERIFY_TEMPLATE_PATTERN = /^[A-Za-z0-9]{1,64}$/;

export function isValidVerifyTemplate(value: unknown): value is string {
  return typeof value === 'string' && VERIFY_TEMPLATE_PATTERN.test(value);
}

export function isSupportedSmsProvider(value: unknown): value is 'kavenegar' | 'smsir' {
  return typeof value === 'string' && (SUPPORTED_SMS_PROVIDERS as readonly string[]).includes(value);
}

export function isKnownSmsProviderName(value: unknown): value is SmsProviderName {
  return typeof value === 'string' && (SMS_PROVIDER_NAMES as readonly string[]).includes(value);
}

interface StoredRow {
  provider_name: string;
  config: Record<string, unknown> | null;
  is_active: boolean;
  updated_at: string | null;
}

function readString(source: Record<string, unknown> | null, key: string): string | null {
  if (!source) return null;
  const value: unknown = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function readInt(source: Record<string, unknown> | null, key: string): number | null {
  if (!source) return null;
  const value: unknown = source[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^[0-9]{1,15}$/.test(value.trim())) return Number(value.trim());
  return null;
}

async function loadRow(serverConfig: ServerConfig): Promise<StoredRow | null> {
  const sb = getServiceClient(serverConfig);
  const { data, error } = await sb
    .from(TABLE)
    .select('provider_name, config, is_active, updated_at')
    .eq('singleton', true)
    .maybeSingle();
  if (error) throw new SmsError('sms_provider_not_configured');
  if (!data) return null;
  const row: StoredRow = {
    provider_name: typeof data.provider_name === 'string' ? data.provider_name : 'disabled',
    config:
      data.config && typeof data.config === 'object' && !Array.isArray(data.config)
        ? (data.config as Record<string, unknown>)
        : null,
    is_active: data.is_active === true,
    updated_at: typeof data.updated_at === 'string' ? data.updated_at : null,
  };
  return row;
}

/** Redacted status for the admin UI. Never includes the credential. */
export async function getSmsProviderInfo(serverConfig: ServerConfig): Promise<SmsProviderInfo> {
  const row = await loadRow(serverConfig);
  if (!row) {
    return {
      providerName: 'disabled',
      configured: false,
      enabled: false,
      hasApiKey: false,
      sender: null,
      verifyTemplate: null,
      lineNumber: null,
      verifyTemplateId: null,
      verifyParameterName: null,
      updatedAt: null,
    };
  }
  const providerName: SmsProviderName = isKnownSmsProviderName(row.provider_name)
    ? row.provider_name
    : 'disabled';
  const apiKey = readString(row.config, 'apiKey');
  return {
    providerName,
    configured: providerName !== 'disabled' && apiKey !== null,
    enabled: row.is_active && providerName !== 'disabled',
    hasApiKey: apiKey !== null,
    sender: readString(row.config, 'sender'),
    verifyTemplate: readString(row.config, 'verifyTemplate'),
    lineNumber: readString(row.config, 'lineNumber'),
    verifyTemplateId: readInt(row.config, 'verifyTemplateId'),
    verifyParameterName: readString(row.config, 'verifyParameterName'),
    updatedAt: row.updated_at,
  };
}

export interface SaveSmsProviderInput {
  providerName: string;
  enabled: boolean;
  /** Omitted / blank on update = keep the stored credential. */
  apiKey?: string;
  /** Kavenegar */
  sender?: string;
  verifyTemplate?: string;
  /** SMS.ir */
  lineNumber?: string;
  verifyTemplateId?: number;
  verifyParameterName?: string;
}

export type SaveSmsProviderError =
  | 'unsupported_provider'
  | 'api_key_required'
  | 'invalid_verify_template'
  | 'invalid_line_number'
  | 'invalid_verify_template_id'
  | 'invalid_verify_parameter_name'
  | 'save_failed';

export class SmsConfigValidationError extends Error {
  readonly reason: SaveSmsProviderError;
  constructor(reason: SaveSmsProviderError) {
    super(reason);
    this.name = 'SmsConfigValidationError';
    this.reason = reason;
  }
}

/**
 * Persist the platform SMS config.
 * Only whitelisted keys are stored — arbitrary JSON is dropped.
 */
export async function saveSmsProviderConfig(
  serverConfig: ServerConfig,
  input: SaveSmsProviderInput,
  adminUserId: string,
): Promise<SmsProviderInfo> {
  if (!isSupportedSmsProvider(input.providerName)) {
    throw new SmsConfigValidationError('unsupported_provider');
  }

  const existing = await loadRow(serverConfig);
  // Switching vendors must never silently reuse the previous vendor's
  // credential — a fresh API key is always required.
  const sameProvider = existing?.provider_name === input.providerName;
  const existingKey = sameProvider ? readString(existing?.config ?? null, 'apiKey') : null;
  const incomingKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  const apiKey = incomingKey !== '' ? incomingKey : existingKey;
  if (!apiKey) throw new SmsConfigValidationError('api_key_required');

  // Only whitelisted keys for the SELECTED vendor are written, so switching
  // vendors wipes every field that belonged to the previous one.
  const nextConfig: Record<string, string | number> = { apiKey };

  if (input.providerName === 'kavenegar') {
    if (!isValidVerifyTemplate(input.verifyTemplate)) {
      throw new SmsConfigValidationError('invalid_verify_template');
    }
    nextConfig.verifyTemplate = input.verifyTemplate;
    const sender = typeof input.sender === 'string' ? input.sender.trim() : '';
    if (sender) nextConfig.sender = sender;
  } else {
    const lineNumber = typeof input.lineNumber === 'string' ? input.lineNumber.trim() : '';
    if (!isValidSmsIrLineNumber(lineNumber)) {
      throw new SmsConfigValidationError('invalid_line_number');
    }
    if (!isValidSmsIrTemplateId(input.verifyTemplateId)) {
      throw new SmsConfigValidationError('invalid_verify_template_id');
    }
    const parameterName =
      typeof input.verifyParameterName === 'string' ? input.verifyParameterName.trim() : '';
    if (!isValidSmsIrParameterName(parameterName)) {
      throw new SmsConfigValidationError('invalid_verify_parameter_name');
    }
    nextConfig.lineNumber = lineNumber;
    nextConfig.verifyTemplateId = input.verifyTemplateId;
    nextConfig.verifyParameterName = parameterName;
  }

  const sb = getServiceClient(serverConfig);
  const { error } = await sb.from(TABLE).upsert(
    {
      singleton: true,
      provider_name: input.providerName,
      config: nextConfig,
      is_active: input.enabled === true,
      updated_by: adminUserId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'singleton' },
  );
  if (error) throw new SmsConfigValidationError('save_failed');

  return getSmsProviderInfo(serverConfig);
}

/** Disable and wipe the stored credential. */
export async function deleteSmsProviderConfig(
  serverConfig: ServerConfig,
  adminUserId: string,
): Promise<SmsProviderInfo> {
  const sb = getServiceClient(serverConfig);
  const { error } = await sb.from(TABLE).upsert(
    {
      singleton: true,
      provider_name: 'disabled',
      config: {},
      is_active: false,
      updated_by: adminUserId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'singleton' },
  );
  if (error) throw new SmsConfigValidationError('save_failed');
  return getSmsProviderInfo(serverConfig);
}

type ResolvedProvider =
  | { providerName: 'kavenegar'; config: KavenegarSmsConfig; adapter: KavenegarAdapter }
  | { providerName: 'smsir'; config: SmsIrSmsConfig; adapter: SmsIrAdapter };

export interface SmsRuntimeOptions {
  /** Test seam forwarded to the vendor adapter. */
  adapterOptions?: KavenegarAdapterOptions;
  /** Test seam forwarded to the SMS.ir adapter. */
  smsIrAdapterOptions?: SmsIrAdapterOptions;
}

/**
 * Resolve the active provider. Fail-closed at every gap:
 * missing row, disabled flag, unsupported vendor, or incomplete credential.
 */
async function resolveProvider(
  serverConfig: ServerConfig,
  options: SmsRuntimeOptions = {},
): Promise<ResolvedProvider> {
  const row = await loadRow(serverConfig);
  if (!row || row.provider_name === 'disabled') {
    throw new SmsError(row ? 'sms_provider_disabled' : 'sms_provider_not_configured');
  }
  if (!isSupportedSmsProvider(row.provider_name)) {
    throw new SmsError('sms_provider_not_configured');
  }
  if (!row.is_active) throw new SmsError('sms_provider_disabled');

  const apiKey = readString(row.config, 'apiKey');
  if (!apiKey) throw new SmsError('sms_provider_not_configured');

  if (row.provider_name === 'kavenegar') {
    const verifyTemplate = readString(row.config, 'verifyTemplate');
    if (!verifyTemplate) throw new SmsError('sms_template_not_found');
    const sender = readString(row.config, 'sender');
    const config: KavenegarSmsConfig = {
      provider: 'kavenegar',
      apiKey,
      verifyTemplate,
      ...(sender ? { sender } : {}),
    };
    return {
      providerName: 'kavenegar',
      config,
      adapter: createKavenegarAdapter(config, options.adapterOptions),
    };
  }

  const lineNumber = readString(row.config, 'lineNumber');
  const verifyTemplateId = readInt(row.config, 'verifyTemplateId');
  const verifyParameterName = readString(row.config, 'verifyParameterName');
  if (!isValidSmsIrLineNumber(lineNumber)) throw new SmsError('sms_provider_not_configured');
  if (!isValidSmsIrTemplateId(verifyTemplateId)) throw new SmsError('sms_template_not_found');
  if (!isValidSmsIrParameterName(verifyParameterName)) throw new SmsError('sms_template_invalid');
  const config: SmsIrSmsConfig = {
    provider: 'smsir',
    apiKey,
    lineNumber,
    verifyTemplateId,
    verifyParameterName,
  };
  return {
    providerName: 'smsir',
    config,
    adapter: createSmsIrAdapter(config, options.smsIrAdapterOptions),
  };
}

function toErrorCode(err: unknown) {
  return err instanceof SmsError ? err.code : 'sms_provider_error';
}

/** Structured, credential-free audit line. */
function logSmsAttempt(entry: {
  provider: string;
  purpose: 'transactional' | 'verification';
  recipient: string;
  success: boolean;
  messageId?: string;
  errorCode?: string;
}): void {
  console.info('[sms]', {
    provider: entry.provider,
    purpose: entry.purpose,
    recipient_masked: maskPhone(entry.recipient),
    success: entry.success,
    provider_message_id: entry.messageId ?? null,
    error_code: entry.errorCode ?? null,
    created_at: new Date().toISOString(),
  });
}

/** Send a plain transactional SMS. Internal service API — no public route. */
export async function sendSms(
  serverConfig: ServerConfig,
  request: SmsSendRequest,
  options: SmsRuntimeOptions = {},
): Promise<SmsSendResult> {
  let provider = 'unknown';
  try {
    const resolved = await resolveProvider(serverConfig, options);
    provider = resolved.providerName;
    const { messageId } =
      resolved.providerName === 'kavenegar'
        ? await resolved.adapter.sendSms({
            receptor: request.to,
            message: request.body,
            ...(request.sender ? { sender: request.sender } : {}),
          })
        : await resolved.adapter.sendSms({
            receptor: request.to,
            message: request.body,
            ...(request.sender ? { lineNumber: request.sender } : {}),
          });
    logSmsAttempt({ provider, purpose: 'transactional', recipient: request.to, success: true, messageId });
    return { success: true, provider, ...(messageId ? { messageId } : {}) };
  } catch (err) {
    const errorCode = toErrorCode(err);
    logSmsAttempt({ provider, purpose: 'transactional', recipient: request.to, success: false, errorCode });
    return { success: false, provider, errorCode };
  }
}

/**
 * Send a verification code via the provider's verification template.
 * Neither the code nor the rendered message body is ever logged.
 */
export async function sendSmsVerification(
  serverConfig: ServerConfig,
  request: SmsVerificationRequest,
  options: SmsRuntimeOptions = {},
): Promise<SmsSendResult> {
  let provider = 'unknown';
  try {
    const resolved = await resolveProvider(serverConfig, options);
    provider = resolved.providerName;
    let messageId: string | undefined;
    if (resolved.providerName === 'kavenegar') {
      const template = request.template ?? resolved.config.verifyTemplate;
      if (!isValidVerifyTemplate(template)) throw new SmsError('sms_template_invalid');
      ({ messageId } = await resolved.adapter.sendVerificationCode({
        receptor: request.to,
        token: request.code,
        template,
      }));
    } else {
      const templateId =
        request.template !== undefined && /^[0-9]{1,15}$/.test(request.template)
          ? Number(request.template)
          : resolved.config.verifyTemplateId;
      if (!isValidSmsIrTemplateId(templateId)) throw new SmsError('sms_template_invalid');
      ({ messageId } = await resolved.adapter.sendVerificationCode({
        receptor: request.to,
        token: request.code,
        templateId,
        parameterName: resolved.config.verifyParameterName,
      }));
    }
    logSmsAttempt({ provider, purpose: 'verification', recipient: request.to, success: true, messageId });
    return { success: true, provider, ...(messageId ? { messageId } : {}) };
  } catch (err) {
    const errorCode = toErrorCode(err);
    logSmsAttempt({ provider, purpose: 'verification', recipient: request.to, success: false, errorCode });
    return { success: false, provider, errorCode };
  }
}

/**
 * Admin connection test. Reads account info only — never sends an SMS.
 * Returns sanitized data: no SDK payload, no credential.
 */
export async function testSmsProvider(
  serverConfig: ServerConfig,
  options: SmsRuntimeOptions = {},
): Promise<SmsTestResult> {
  const startedAt = Date.now();
  let provider = 'unknown';
  try {
    const resolved = await resolveProvider(serverConfig, options);
    provider = resolved.providerName;
    const info = await resolved.adapter.getAccountInfo();
    return {
      success: true,
      provider,
      latencyMs: Date.now() - startedAt,
      balance: info.balance,
      currency: info.currency,
      accountType: info.accountType,
    };
  } catch (err) {
    const errorCode = toErrorCode(err);
    return {
      success: false,
      provider,
      latencyMs: Date.now() - startedAt,
      errorCode,
      error: err instanceof SmsError ? err.message : 'SMS provider returned an error',
    };
  }
}
