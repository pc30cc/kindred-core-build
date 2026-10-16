/**
 * TELNYX ADAPTER (Telnyx Verify, International edition)
 *
 * Plain `fetch` against the Telnyx v2 REST API — no SDK. Only the calls this
 * platform consumes are made:
 *
 *   POST /verifications/sms | /verifications/call   deliver one code
 *   GET  /verifications/{id}                         that code's delivery status
 *   GET  /verify_profiles/{id}                       the admin connection test
 *
 * The code is OURS (`custom_code`): the verification service generates,
 * hashes, rate-limits and checks it exactly as for the other vendors; Telnyx
 * only delivers it, worded by the Verify Profile's own message template. So
 * Telnyx's own check endpoint is never called, and none of our SMS text
 * templates is used for this vendor.
 *
 * SECURITY
 * - The API key only ever travels in the `Authorization` header. It is never
 *   placed in an error, a log line or a return value.
 * - Telnyx's response bodies (and their `errors[].detail`, which can echo the
 *   phone number) are read only to choose a closed `SmsErrorCode`; they never
 *   leave this module.
 * - Every failure — HTTP error, malformed body, network error, timeout —
 *   becomes an `SmsError`.
 */

import {
  SmsError,
  type SmsAccountInfo,
  type SmsDeliveryState,
  type SmsErrorCode,
  type TelnyxChannel,
  type TelnyxSmsConfig,
} from '../types.js';

export const TELNYX_API_BASE = 'https://api.telnyx.com/v2';

/** Hard ceiling for any single provider call (same as the other adapters). */
export const TELNYX_TIMEOUT_MS = 10_000;

/**
 * `timeout_secs` sent with a code. Telnyx documents no range for it (the SDK
 * only says "the number of seconds the verification code is valid for"), so
 * our own TTL is sent as is, only kept to a sane whole number of seconds.
 */
export const TELNYX_MIN_TIMEOUT_SECS = 30;
export const TELNYX_MAX_TIMEOUT_SECS = 86_400;
export const TELNYX_DEFAULT_TIMEOUT_SECS = 300;

export function telnyxTimeoutSecs(ttlSeconds: unknown): number {
  if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds)) return TELNYX_DEFAULT_TIMEOUT_SECS;
  return Math.min(TELNYX_MAX_TIMEOUT_SECS, Math.max(TELNYX_MIN_TIMEOUT_SECS, Math.round(ttlSeconds)));
}

/** A Verify Profile id: a UUID (any version). */
export const TELNYX_PROFILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidTelnyxProfileId(value: unknown): value is string {
  return typeof value === 'string' && TELNYX_PROFILE_ID_PATTERN.test(value.trim());
}

export function isTelnyxChannel(value: unknown): value is TelnyxChannel {
  return value === 'sms' || value === 'call';
}

/** E.164: `+`, a country code that does not start with 0, 7–15 digits in all. */
export const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

/** A Telnyx verification id, as returned when a code is sent. */
const VERIFICATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A verification's `delivery_status` (e.g. `delivery_failed`, `delivered`,
 * `sent`, `queued`) reduced to our four states. Telnyx lists no closed set
 * of values, so anything that names a failure counts as failed, an exact
 * `delivered` as delivered, and the rest as still on its way.
 */
export function mapTelnyxDeliveryStatus(value: unknown): SmsDeliveryState {
  const status = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!status) return 'unknown';
  if (/fail|undeliver|reject|expired|blocked|error/.test(status)) return 'failed';
  if (status === 'delivered') return 'delivered';
  return 'pending';
}

/** Our code: digits only (Telnyx's `custom_code` is "a self-generated numeric code"). */
const CUSTOM_CODE_PATTERN = /^[0-9]{4,10}$/;

interface TelnyxErrorEntry {
  code: string;
  title: string;
  detail: string;
  pointer: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

/** `{ errors: [{ code, title, detail, source: { pointer } }] }` → plain strings. */
function readErrors(body: unknown): TelnyxErrorEntry[] {
  const list: unknown = asRecord(body)?.errors;
  if (!Array.isArray(list)) return [];
  return list.map((raw) => {
    const e = asRecord(raw) ?? {};
    return {
      code: text(e.code),
      title: text(e.title),
      detail: text(e.detail),
      pointer: text(asRecord(e.source)?.pointer),
    };
  });
}

/**
 * Map a Telnyx failure to the closed `SmsErrorCode` union.
 *
 *   401 / 403                                   → sms_auth_failed
 *   402, or a balance / funds message           → sms_insufficient_credit
 *   404 (the Verify Profile does not exist)     → sms_template_not_found
 *   422 on phone_number / a destination refusal → sms_invalid_receptor
 *   422 on verify_profile_id                    → sms_template_not_found
 *   422 on custom_code                          → sms_template_invalid
 *   408 / 504                                   → sms_timeout
 *   other 5xx                                   → sms_network_error
 *   429 and everything else                     → sms_provider_error
 */
export function mapTelnyxFailure(status: number, body: unknown): SmsErrorCode {
  const errors = readErrors(body);
  const haystack = errors
    .map((e) => `${e.code} ${e.title} ${e.detail} ${e.pointer}`)
    .join(' ')
    .toLowerCase();

  if (status === 401 || status === 403) return 'sms_auth_failed';
  if (status === 402 || /insufficient|balance|funds|credit/.test(haystack)) return 'sms_insufficient_credit';
  if (status === 404) return 'sms_template_not_found';
  if (status === 408 || status === 504) return 'sms_timeout';
  if (status >= 500) return 'sms_network_error';
  if (status === 400 || status === 422) {
    // The field Telnyx names (`source.pointer`) is the most precise signal.
    const pointers = errors.map((e) => e.pointer.toLowerCase()).join(' ');
    if (pointers.includes('phone_number')) return 'sms_invalid_receptor';
    if (pointers.includes('verify_profile_id')) return 'sms_template_not_found';
    if (pointers.includes('custom_code')) return 'sms_template_invalid';
    if (/phone_number|phone number|destination|whitelist|e\.?164|invalid number/.test(haystack)) {
      return 'sms_invalid_receptor';
    }
    if (/verify_profile|verify profile/.test(haystack)) return 'sms_template_not_found';
    if (/custom_code/.test(haystack)) return 'sms_template_invalid';
  }
  return 'sms_provider_error';
}

export type TelnyxFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface TelnyxAdapterOptions {
  /** Test seam — a fake `fetch`. Production leaves this undefined. */
  fetchImpl?: TelnyxFetch;
  timeoutMs?: number;
  baseUrl?: string;
}

export interface TelnyxAdapter {
  /** Deliver our code to an E.164 number through the Verify Profile. */
  sendVerificationCode(input: {
    phoneNumber: string;
    code: string;
    timeoutSecs?: number;
    /** Overrides the configured channel for this one code. */
    channel?: TelnyxChannel;
  }): Promise<{ messageId?: string; channel: TelnyxChannel }>;
  /** What Telnyx reports about one sent code. Never throws: failures read 'unknown'. */
  getDeliveryState(messageId: string): Promise<SmsDeliveryState>;
  /** The configured Verify Profile (proves the key and the profile id). Never sends anything. */
  getAccountInfo(): Promise<SmsAccountInfo>;
}

function isAbortError(err: unknown): boolean {
  const name = asRecord(err)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

export function createTelnyxAdapter(
  config: TelnyxSmsConfig,
  options: TelnyxAdapterOptions = {},
): TelnyxAdapter {
  if (!config.apiKey || !isValidTelnyxProfileId(config.verifyProfileId)) {
    throw new SmsError('sms_provider_not_configured');
  }
  const timeoutMs = options.timeoutMs ?? TELNYX_TIMEOUT_MS;
  const baseUrl = (options.baseUrl ?? TELNYX_API_BASE).replace(/\/+$/, '');
  const doFetch: TelnyxFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const profileId = config.verifyProfileId.trim().toLowerCase();
  const channel: TelnyxChannel = isTelnyxChannel(config.channel) ? config.channel : 'sms';

  async function call(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new SmsError(timedOut || isAbortError(err) ? 'sms_timeout' : 'sms_network_error');
    }

    let parsed: unknown = null;
    try {
      const raw = await response.text();
      parsed = raw ? (JSON.parse(raw) as unknown) : null;
    } catch (err) {
      clearTimeout(timer);
      if (timedOut || isAbortError(err)) throw new SmsError('sms_timeout');
      // A body that is not JSON: only the status can be trusted.
      if (!response.ok) throw new SmsError(mapTelnyxFailure(response.status, null));
      throw new SmsError('sms_provider_error');
    }
    clearTimeout(timer);

    if (!response.ok) throw new SmsError(mapTelnyxFailure(response.status, parsed));
    return parsed;
  }

  return {
    async sendVerificationCode({ phoneNumber, code, timeoutSecs, channel: requested }) {
      const to = typeof phoneNumber === 'string' ? phoneNumber.trim() : '';
      if (!E164_PATTERN.test(to)) throw new SmsError('sms_invalid_receptor');
      if (typeof code !== 'string' || !CUSTOM_CODE_PATTERN.test(code)) throw new SmsError('sms_template_invalid');
      const via: TelnyxChannel = requested === undefined ? channel : requested;
      if (!isTelnyxChannel(via)) throw new SmsError('sms_provider_feature_unavailable');
      const data = asRecord(
        asRecord(
          await call('POST', `/verifications/${via}`, {
            phone_number: to,
            verify_profile_id: profileId,
            custom_code: code,
            timeout_secs: telnyxTimeoutSecs(timeoutSecs),
          }),
        )?.data,
      );
      if (!data) throw new SmsError('sms_provider_error');
      const id = text(data.id).trim();
      return id ? { messageId: id, channel: via } : { channel: via };
    },

    async getDeliveryState(messageId) {
      const id = typeof messageId === 'string' ? messageId.trim() : '';
      if (!VERIFICATION_ID_PATTERN.test(id)) return 'unknown';
      try {
        const data = asRecord(asRecord(await call('GET', `/verifications/${encodeURIComponent(id)}`))?.data);
        return data ? mapTelnyxDeliveryStatus(data.delivery_status) : 'unknown';
      } catch {
        return 'unknown';
      }
    },

    async getAccountInfo() {
      const data = asRecord(asRecord(await call('GET', `/verify_profiles/${encodeURIComponent(profileId)}`))?.data);
      if (!data) throw new SmsError('sms_provider_error');
      // Answered for a different profile: treat as "this profile is not there".
      const id = text(data.id).trim().toLowerCase();
      if (id && id !== profileId) throw new SmsError('sms_template_not_found');
      const name = text(data.name).trim();
      return {
        balance: null,
        currency: 'USD',
        accountType: null,
        profileName: name ? name.slice(0, 120) : null,
      };
    },
  };
}
