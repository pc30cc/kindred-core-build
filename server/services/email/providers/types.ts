// ============================================
// EMAIL PROVIDER ADAPTERS: the one shape every provider has
// ============================================
//
// server/services/email/index.ts builds one OutboundMessage and hands it to
// whichever adapter the platform's provider names (the registry, ./index.ts).
// Everything a provider does differently (its wire format, its timeouts, how
// it reports a failure) stays inside its adapter; what every adapter returns
// is the same SendResult, so no caller ever learns which provider sent.

import type { EmailProviderAdapter } from '../../../../shared/emailProviders.js';

export type EmailCategory = 'transactional' | 'notification' | 'marketing';

export type EmailErrorCode =
  | 'unconfigured' | 'invalid_recipient' | 'suppressed' | 'timeout' | 'connection'
  | 'auth' | 'rejected' | 'provider_error' | 'template_missing' | 'edition_unavailable';

export const EMAIL_ERROR_CODES: readonly EmailErrorCode[] = [
  'unconfigured', 'invalid_recipient', 'suppressed', 'timeout', 'connection',
  'auth', 'rejected', 'provider_error', 'template_missing', 'edition_unavailable',
];

export interface ProviderConfig {
  provider_name: string;
  config: Record<string, unknown>;
}

export interface SendResult {
  success: boolean;
  id?: string;
  provider: string;
  /**
   * `"<errorCode>: <short reason>"`, written by this module, never a
   * provider's own text: it is stored in `email_logs` (readable by a
   * workspace's admins) and returned by routes. The provider's raw answer
   * goes to the server console only.
   */
  error?: string;
  errorCode?: EmailErrorCode;
  /** True when retrying the same message cannot succeed. */
  permanent?: boolean;
  /** Set by the outbox's sendEmailWithRetry when a retry was queued. */
  queuedRetry?: boolean;
  /**
   * The id the receiving server gave the message, when it said one (an SMTP
   * relay's queue id, e.g. Postfix's "queued as …"), so a delivery log line
   * can be matched with the relay's own.
   */
  serverMessageId?: string;
}

/** What every adapter sends: built once by the email service, for every provider alike. */
export interface OutboundMessage {
  from: { name: string; address: string };
  /** Exactly one plain address. */
  to: string;
  subject: string;
  /** Empty when the message has no HTML part. */
  html: string;
  /** Always present. */
  text: string;
  replyTo?: string;
  headers: Record<string, string>;
  /** The kind of mail, for a provider that can tag it (it changes nothing in the message). */
  category?: EmailCategory;
}

export interface EmailProviderVerifyResult {
  ok: boolean;
  /** Safe for the Super Admin: never a credential, never the provider's raw text. */
  detail: string;
}

export interface EmailAdapter {
  name: EmailProviderAdapter;
  send(config: ProviderConfig, message: OutboundMessage): Promise<SendResult>;
  /** Connects and authenticates without sending anything. */
  verify?(config: ProviderConfig): Promise<EmailProviderVerifyResult>;
}

/** HTTP APIs answer within this or the attempt is a timeout. */
export const HTTP_TIMEOUT_MS = 15_000;

/**
 * A signal that aborts a fetch (and the read of its body) after `ms` with a
 * TimeoutError. AbortSignal.timeout where the runtime has it (Node 24);
 * elsewhere (a test's browser-like environment) a timer that does not keep
 * the process alive does the same.
 */
export function timeoutSignal(ms: number = HTTP_TIMEOUT_MS): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
  (timer as { unref?: () => void }).unref?.();
  return controller.signal;
}

/**
 * Whether a failure of this kind can succeed on a retry of the same message,
 * when the adapter has nothing more precise to say. A configuration fault
 * (missing setting, refused sign-in) does not fix itself, and neither does a
 * bad address; a connection that timed out or dropped may well work the
 * next time, as may a template's edition that could not be told yet.
 */
const PERMANENT_BY_DEFAULT: Record<EmailErrorCode, boolean> = {
  unconfigured: true,
  invalid_recipient: true,
  suppressed: true,
  timeout: false,
  connection: false,
  auth: true,
  rejected: true,
  provider_error: false,
  template_missing: true,
  edition_unavailable: false,
};

/** Every known credential value in `text` replaced, and the text kept to one short line. */
export function scrubDetail(text: string, secrets: Array<unknown> = []): string {
  let out = String(text ?? '').replace(/[\r\n]+/g, ' ');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) out = out.split(secret).join('[REDACTED]');
  }
  return out.length > 500 ? `${out.slice(0, 500)}…` : out;
}

/**
 * A failed SendResult. `reason` is ours and short, and it is all a caller,
 * a route or `email_logs` ever sees; `detail` (the provider's own words) is
 * printed to the server console, with any credential the adapter names in
 * `secrets` cut out first.
 */
export function emailFailure(
  provider: string,
  code: EmailErrorCode,
  reason: string,
  opts: { permanent?: boolean; detail?: string; secrets?: Array<unknown> } = {},
): SendResult {
  if (opts.detail) console.warn(`[email:${provider}] ${code}: ${scrubDetail(opts.detail, opts.secrets)}`);
  return {
    success: false,
    provider,
    errorCode: code,
    permanent: opts.permanent ?? PERMANENT_BY_DEFAULT[code],
    error: `${code}: ${reason}`,
  };
}

/** A display name needs quotes when it holds anything but letters, digits, spaces and atext. */
const PLAIN_DISPLAY_NAME = /^[\p{L}\p{N}!#$%&'*+\-/=?^_`{|}~ ]+$/u;

/**
 * `Name <address>` for an API that takes the From as one string, with the
 * name quoted (and its quotes and backslashes escaped) when it holds a comma,
 * a dot, an `@`, angle brackets or anything else a parser would split on.
 */
export function formatMailbox(mailbox: { name: string; address: string }): string {
  const name = mailbox.name.replace(/[\r\n]+/g, ' ').trim();
  if (!name) return mailbox.address;
  if (PLAIN_DISPLAY_NAME.test(name)) return `${name} <${mailbox.address}>`;
  return `"${name.replace(/(["\\])/g, '\\$1')}" <${mailbox.address}>`;
}

/**
 * An HTTP API's error answer, classified the same way for every provider: a
 * refused key or account is `auth`, a refused message `rejected` (both
 * permanent), a rate limit or a server error transient.
 */
export function httpFailure(provider: string, status: number, body: string, secrets: Array<unknown> = []): SendResult {
  const detail = `HTTP ${status}: ${body}`;
  if (status === 401 || status === 403) {
    return emailFailure(provider, 'auth', `the provider refused the credentials or the sender (HTTP ${status})`, { detail, secrets });
  }
  if (status === 408) {
    return emailFailure(provider, 'timeout', 'the provider timed out (HTTP 408)', { detail, secrets, permanent: false });
  }
  if (status === 429) {
    return emailFailure(provider, 'provider_error', 'the provider is rate-limiting (HTTP 429)', { detail, secrets, permanent: false });
  }
  if (status >= 500) {
    return emailFailure(provider, 'provider_error', `the provider failed (HTTP ${status})`, { detail, secrets, permanent: false });
  }
  return emailFailure(provider, 'rejected', `the provider refused the message (HTTP ${status})`, { detail, secrets });
}

/** A fetch that threw: our own timeout, or the network. */
export function fetchFailure(provider: string, err: unknown, secrets: Array<unknown> = []): SendResult {
  const name = (err as { name?: string } | null)?.name;
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'TimeoutError' || name === 'AbortError') {
    return emailFailure(provider, 'timeout', `the provider did not answer within ${HTTP_TIMEOUT_MS / 1000} s`, { detail: message, secrets });
  }
  return emailFailure(provider, 'connection', 'the provider could not be reached', { detail: message, secrets });
}

export function configText(cfg: Record<string, unknown>, key: string): string {
  const value = cfg[key];
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** A password as typed (a space at either end can be part of it); blank is none. */
export function configSecret(cfg: Record<string, unknown>, key: string): string {
  const value = cfg[key];
  return typeof value === 'string' && value.trim() ? value : '';
}
