/**
 * KAVENEGAR ADAPTER
 *
 * Wraps the official `kavenegar@1.1.4` SDK (CommonJS) behind a narrow,
 * promise-based, type-safe interface. Only the three operations this platform
 * actually consumes are exposed: Send, VerifyLookup and AccountInfo.
 *
 * SECURITY
 * - The SDK is only ever imported here (server-side). It never reaches the
 *   browser bundle.
 * - No credential is ever placed in an error message, log line or return value.
 * - Every call is fail-closed: malformed responses, double callbacks, sync
 *   throws and timeouts all resolve to a normalized `SmsError`.
 */

import { createRequire } from 'node:module';
import {
  SmsError,
  type SmsErrorCode,
  type KavenegarSmsConfig,
  type SmsAccountInfo,
} from '../types.js';

/** Hard ceiling for any single provider call. */
export const KAVENEGAR_TIMEOUT_MS = 10_000;

/**
 * Minimal local typing for the parts of the SDK we consume.
 * The SDK ships no types; we deliberately model only these methods.
 */
export type KavenegarCallback = (
  entries: unknown,
  status?: unknown,
  message?: unknown,
) => void;

export interface KavenegarApiClient {
  Send(params: Record<string, string>, callback: KavenegarCallback): void;
  VerifyLookup(params: Record<string, string>, callback: KavenegarCallback): void;
  AccountInfo(params: Record<string, string>, callback: KavenegarCallback): void;
}

export interface KavenegarModule {
  KavenegarApi(options: { apikey: string }): KavenegarApiClient;
}

let cachedModule: KavenegarModule | null = null;

function loadKavenegarModule(): KavenegarModule {
  if (!cachedModule) {
    const nodeRequire = createRequire(import.meta.url);
    // The SDK is CommonJS; `require` returns an untyped value which we
    // immediately narrow to the minimal interface declared above.
    const loaded: KavenegarModule = nodeRequire('kavenegar');
    cachedModule = loaded;
  }
  return cachedModule;
}

/**
 * Map a Kavenegar `return.status` to a normalized internal error code.
 * Reference: https://kavenegar.com/rest.html
 */
export function mapKavenegarStatus(status: number): SmsErrorCode {
  switch (status) {
    case 401:
    case 403:
    case 407:
      return 'sms_auth_failed';
    case 411:
    case 412:
      return 'sms_invalid_receptor';
    case 418:
    case 419:
      return 'sms_insufficient_credit';
    case 424:
      return 'sms_template_not_found';
    case 426:
      return 'sms_provider_feature_unavailable';
    case 428:
      return 'sms_template_not_approved';
    case 431:
    case 432:
      return 'sms_template_invalid';
    default:
      return 'sms_provider_error';
  }
}

/**
 * Promise wrapper around a callback-based SDK call.
 * Guarantees exactly one settlement, enforces a timeout and captures sync throws.
 */
export function kavenegarCall(
  invoke: (callback: KavenegarCallback) => void,
  timeoutMs: number = KAVENEGAR_TIMEOUT_MS,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new SmsError('sms_timeout'));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const finish = (err: SmsError | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };

    const callback: KavenegarCallback = (entries, status) => {
      // A transport failure invokes the callback with a single argument.
      if (typeof status !== 'number') {
        finish(new SmsError('sms_network_error'));
        return;
      }
      if (status !== 200) {
        finish(new SmsError(mapKavenegarStatus(status)));
        return;
      }
      finish(null, entries);
    };

    try {
      invoke(callback);
    } catch {
      finish(new SmsError('sms_network_error'));
    }
  });
}

function firstEntry(entries: unknown): Record<string, unknown> | null {
  if (Array.isArray(entries)) {
    const head: unknown = entries[0];
    return head && typeof head === 'object' ? (head as Record<string, unknown>) : null;
  }
  if (entries && typeof entries === 'object') return entries as Record<string, unknown>;
  return null;
}

function readMessageId(entries: unknown): string | undefined {
  const entry = firstEntry(entries);
  if (!entry) return undefined;
  const id: unknown = entry.messageid;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  if (typeof id === 'string' && id.trim()) return id.trim();
  return undefined;
}

export interface KavenegarAdapter {
  sendSms(input: { receptor: string; message: string; sender?: string }): Promise<{ messageId?: string }>;
  sendVerificationCode(input: { receptor: string; token: string; template: string }): Promise<{ messageId?: string }>;
  getAccountInfo(): Promise<SmsAccountInfo>;
}

export interface KavenegarAdapterOptions {
  /** Test seam — injects a fake SDK client. Production leaves this undefined. */
  createClient?: (apiKey: string) => KavenegarApiClient;
  timeoutMs?: number;
}

export function createKavenegarAdapter(
  config: KavenegarSmsConfig,
  options: KavenegarAdapterOptions = {},
): KavenegarAdapter {
  const timeoutMs = options.timeoutMs ?? KAVENEGAR_TIMEOUT_MS;
  const factory =
    options.createClient ??
    ((apiKey: string) => loadKavenegarModule().KavenegarApi({ apikey: apiKey }));

  let client: KavenegarApiClient | null = null;
  const getClient = (): KavenegarApiClient => {
    if (!client) client = factory(config.apiKey);
    return client;
  };

  return {
    async sendSms({ receptor, message, sender }) {
      const params: Record<string, string> = { receptor, message };
      const effectiveSender = sender ?? config.sender;
      if (effectiveSender) params.sender = effectiveSender;
      const entries = await kavenegarCall((cb) => getClient().Send(params, cb), timeoutMs);
      return { messageId: readMessageId(entries) };
    },

    async sendVerificationCode({ receptor, token, template }) {
      // Sender is intentionally NOT sent: Kavenegar selects the approved line
      // for VerifyLookup itself.
      const params: Record<string, string> = {
        receptor,
        token,
        template,
        type: 'sms',
      };
      const entries = await kavenegarCall((cb) => getClient().VerifyLookup(params, cb), timeoutMs);
      return { messageId: readMessageId(entries) };
    },

    async getAccountInfo() {
      const entries = await kavenegarCall((cb) => getClient().AccountInfo({}, cb), timeoutMs);
      const entry = firstEntry(entries);
      if (!entry) throw new SmsError('sms_provider_error');
      const remain: unknown = entry.remaincredit;
      const type: unknown = entry.type;
      const balance =
        typeof remain === 'number' && Number.isFinite(remain)
          ? remain
          : typeof remain === 'string' && remain.trim() !== '' && Number.isFinite(Number(remain))
            ? Number(remain)
            : null;
      if (balance === null && typeof type !== 'string') {
        throw new SmsError('sms_provider_error');
      }
      return {
        balance,
        currency: 'IRR',
        accountType: typeof type === 'string' ? type : null,
      };
    },
  };
}
