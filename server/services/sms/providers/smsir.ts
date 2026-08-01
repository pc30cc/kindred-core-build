/**
 * SMS.IR ADAPTER
 *
 * Wraps the official `sms-typescript@2.0.2` SDK behind the same narrow,
 * fail-closed interface used for Kavenegar. Only the three operations this
 * platform consumes are exposed: sendBulk, sendVerifyCode and getCredit.
 *
 * SECURITY
 * - The SDK is only ever imported here (server-side); it never reaches the
 *   browser bundle.
 * - No credential, raw SDK error, URL or OTP value is ever logged or returned.
 * - Malformed responses, sync throws and timeouts all become `SmsError`.
 */

import { createRequire } from 'node:module';
import {
  SmsError,
  type SmsErrorCode,
  type SmsIrSmsConfig,
  type SmsAccountInfo,
} from '../types.js';

/** Hard ceiling for any single provider call. */
export const SMSIR_TIMEOUT_MS = 10_000;

export interface SmsIrParameter {
  name: string;
  value: string;
}

/** Minimal local typing for the parts of the SDK we consume. */
export interface SmsIrClient {
  sendBulk(
    messageText: string,
    mobiles: string[],
    sendDateTime?: number,
    customLineNumber?: number,
  ): Promise<unknown>;
  sendVerifyCode(
    mobile: string,
    templateId: number,
    parameters: SmsIrParameter[],
  ): Promise<unknown>;
  getCredit(): Promise<unknown>;
}

export interface SmsIrModule {
  Smsir: new (apiKey: string, lineNumber: number) => SmsIrClient;
}

let cachedModule: SmsIrModule | null = null;

function loadSmsIrModule(): SmsIrModule {
  if (!cachedModule) {
    const nodeRequire = createRequire(import.meta.url);
    // The SDK ships a CommonJS build; `require` avoids the ESM extension issue
    // documented by the vendor. The untyped value is narrowed immediately.
    const loaded: SmsIrModule = nodeRequire('sms-typescript');
    cachedModule = loaded;
  }
  return cachedModule;
}

/** Line numbers are digits only and must survive the JS number conversion. */
export const SMSIR_LINE_NUMBER_PATTERN = /^[0-9]{1,20}$/;
export const SMSIR_PARAMETER_NAME_PATTERN = /^[A-Za-z0-9_]{1,50}$/;

export function isValidSmsIrLineNumber(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!SMSIR_LINE_NUMBER_PATTERN.test(trimmed)) return false;
  return Number.isSafeInteger(Number(trimmed));
}

export function isValidSmsIrTemplateId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER;
}

export function isValidSmsIrParameterName(value: unknown): value is string {
  return typeof value === 'string' && SMSIR_PARAMETER_NAME_PATTERN.test(value);
}

/**
 * Map an SMS.ir failure to a normalized internal error code.
 * The SDK throws `Error("HTTP error! status: <code> - <message>")`, so both the
 * HTTP status and the message text are considered — never re-exposed.
 */
export function mapSmsIrFailure(status: number | null, message: string): SmsErrorCode {
  const text = message.toLowerCase();
  if (status === 401 || status === 403) return 'sms_auth_failed';
  if (status === 402) return 'sms_insufficient_credit';
  if (text.includes('credit') || text.includes('اعتبار')) return 'sms_insufficient_credit';
  if (text.includes('api key') || text.includes('apikey') || text.includes('unauthor')) return 'sms_auth_failed';
  if (text.includes('template')) return 'sms_template_not_found';
  if (text.includes('mobile') || text.includes('receptor') || text.includes('شماره')) {
    return 'sms_invalid_receptor';
  }
  if (status === 404) return 'sms_template_not_found';
  if (status !== null && status >= 500) return 'sms_network_error';
  return 'sms_provider_error';
}

function parseHttpStatus(message: string): number | null {
  const match = /status:\s*(\d{3})/.exec(message);
  return match ? Number(match[1]) : null;
}

function normalizeThrown(err: unknown): SmsError {
  if (err instanceof SmsError) return err;
  if (err instanceof Error) {
    const raw = err.message ?? '';
    if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(raw)) {
      return new SmsError('sms_network_error');
    }
    return new SmsError(mapSmsIrFailure(parseHttpStatus(raw), raw));
  }
  return new SmsError('sms_provider_error');
}

/**
 * Promise timeout wrapper. The SDK exposes no AbortSignal, so a late
 * resolution is simply ignored — the caller has already been rejected.
 */
export function smsIrCall<T>(
  invoke: () => Promise<T>,
  timeoutMs: number = SMSIR_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new SmsError('sms_timeout'));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    try {
      invoke().then(
        (value) => done(() => resolve(value)),
        (err: unknown) => done(() => reject(normalizeThrown(err))),
      );
    } catch (err) {
      done(() => reject(normalizeThrown(err)));
    }
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** SMS.ir wraps every payload in `{ status, message, data }`; 1 means success. */
function readEnvelope(response: unknown): unknown {
  const envelope = asRecord(response);
  if (!envelope) throw new SmsError('sms_provider_error');
  const status: unknown = envelope.status;
  const message: unknown = envelope.message;
  if (typeof status !== 'number') throw new SmsError('sms_provider_error');
  if (status !== 1) {
    throw new SmsError(mapSmsIrFailure(null, typeof message === 'string' ? message : ''));
  }
  return envelope.data;
}

function normalizeId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return undefined;
}

export interface SmsIrAdapter {
  sendSms(input: { receptor: string; message: string; lineNumber?: string }): Promise<{ messageId?: string }>;
  sendVerificationCode(input: {
    receptor: string;
    token: string;
    templateId: number;
    parameterName: string;
  }): Promise<{ messageId?: string }>;
  getAccountInfo(): Promise<SmsAccountInfo>;
}

export interface SmsIrAdapterOptions {
  /** Test seam — injects a fake SDK client. Production leaves this undefined. */
  createClient?: (apiKey: string, lineNumber: number) => SmsIrClient;
  timeoutMs?: number;
}

export function createSmsIrAdapter(
  config: SmsIrSmsConfig,
  options: SmsIrAdapterOptions = {},
): SmsIrAdapter {
  const timeoutMs = options.timeoutMs ?? SMSIR_TIMEOUT_MS;
  if (!isValidSmsIrLineNumber(config.lineNumber)) {
    throw new SmsError('sms_provider_not_configured');
  }
  if (!isValidSmsIrTemplateId(config.verifyTemplateId)) {
    throw new SmsError('sms_template_invalid');
  }
  if (!isValidSmsIrParameterName(config.verifyParameterName)) {
    throw new SmsError('sms_template_invalid');
  }
  const defaultLine = Number(config.lineNumber.trim());
  const factory =
    options.createClient ??
    ((apiKey: string, lineNumber: number) => new (loadSmsIrModule().Smsir)(apiKey, lineNumber));

  let client: SmsIrClient | null = null;
  const getClient = (): SmsIrClient => {
    if (!client) client = factory(config.apiKey, defaultLine);
    return client;
  };

  return {
    async sendSms({ receptor, message, lineNumber }) {
      let overrideLine: number | undefined;
      if (lineNumber !== undefined) {
        // Arbitrary / Kavenegar-style sender values are rejected outright.
        if (!isValidSmsIrLineNumber(lineNumber)) throw new SmsError('sms_provider_error');
        overrideLine = Number(lineNumber.trim());
      }
      const data = await smsIrCall(
        () =>
          getClient()
            .sendBulk(message, [receptor], undefined, overrideLine)
            .then(readEnvelope),
        timeoutMs,
      );
      const payload = asRecord(data);
      if (!payload) throw new SmsError('sms_provider_error');
      const ids: unknown = payload.messageIds;
      const first = Array.isArray(ids) ? normalizeId(ids[0]) : undefined;
      return { messageId: first ?? normalizeId(payload.packId) };
    },

    async sendVerificationCode({ receptor, token, templateId, parameterName }) {
      if (!isValidSmsIrTemplateId(templateId)) throw new SmsError('sms_template_invalid');
      if (!isValidSmsIrParameterName(parameterName)) throw new SmsError('sms_template_invalid');
      const data = await smsIrCall(
        () =>
          getClient()
            .sendVerifyCode(receptor, templateId, [{ name: parameterName, value: token }])
            .then(readEnvelope),
        timeoutMs,
      );
      const payload = asRecord(data);
      if (!payload) throw new SmsError('sms_provider_error');
      const messageId = normalizeId(payload.messageId);
      if (!messageId) throw new SmsError('sms_provider_error');
      return { messageId };
    },

    async getAccountInfo() {
      const data = await smsIrCall(() => getClient().getCredit().then(readEnvelope), timeoutMs);
      const balance =
        typeof data === 'number' && Number.isFinite(data)
          ? data
          : typeof data === 'string' && data.trim() !== '' && Number.isFinite(Number(data))
            ? Number(data)
            : null;
      if (balance === null) throw new SmsError('sms_provider_error');
      // SMS.ir does not document a currency unit for `getCredit`; the project
      // convention (IRR) is kept and the UI labels it as account credit.
      return { balance, currency: 'IRR', accountType: null };
    },
  };
}