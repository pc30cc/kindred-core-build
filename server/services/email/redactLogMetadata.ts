// ============================================
// EMAIL LOG METADATA REDACTION
// ============================================
//
// `email_logs.metadata` is readable by workspace owners/admins
// (GET /api/workspace-integrations/:ws/email-logs) and by platform admins
// (GET /api/admin/users/:userId/messages). Template data routinely carries
// bearer secrets — password-reset / email-verify links with the raw token in
// the query string, OTP codes, invitation accept links — and a row that stores
// them verbatim hands an account takeover to whoever can read the log.
//
// The rule: nothing that could be a credential is ever persisted, and nothing
// already persisted (older rows) is ever returned. This one helper is applied
// on both sides — before the insert and again on every read path.

export const REDACTED = '[REDACTED]';

/** In place of a bulky template value the log does not keep. */
export const OMITTED = '[OMITTED]';

/**
 * Template data that is a whole document rather than a field: the visitor's
 * conversation transcript (services/visitorTranscript.ts, up to 200 KiB of
 * HTML and its text twin). The mail carried it; the log row keeps only that
 * it was there, so a delivery log is neither a second copy of the
 * conversation nor 400 KiB a row.
 */
const BULKY_KEY = /^(transcript|transcript_text)$/i;

/**
 * Any key whose name suggests a credential or a credential-bearing link.
 * Matched case-insensitively as a substring, so `action_url`, `verifyUrl`,
 * `reset_link`, `otp_code`, `accessToken`, `magicLink` … all qualify.
 */
const SENSITIVE_KEY =
  /token|url|uri|link|href|code|otp|password|passwd|secret|key|auth|signature|hash|nonce|credential|(^|[_-])pin($|[_-])/i;

/** Values that contain a URL carrying a query string or fragment. */
const URL_WITH_PARAMS = /[a-z][a-z0-9+.-]*:\/\/\S*[?#]/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 8) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (isPlainObject(value)) return redactRecord(value, depth + 1);
  // A URL with a query/fragment may carry a token even under an innocuous key.
  if (typeof value === 'string' && URL_WITH_PARAMS.test(value)) return REDACTED;
  return value;
}

function redactRecord(obj: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (BULKY_KEY.test(key) && value !== null && value !== undefined && value !== '') {
      out[key] = OMITTED;
    } else if (SENSITIVE_KEY.test(key) && value !== null && value !== undefined && value !== '') {
      out[key] = REDACTED;
    } else {
      out[key] = redactValue(value, depth);
    }
  }
  return out;
}

/**
 * Returns a deep copy of `value` with every credential-looking field replaced
 * by `[REDACTED]` and every bulky one (a transcript) by `[OMITTED]`, on
 * writes and on reads of older rows alike. Non-object input is returned
 * unchanged (after URL check). Never throws.
 */
export function redactSecrets<T>(value: T): T {
  try {
    return redactValue(value, 0) as T;
  } catch {
    return REDACTED as unknown as T;
  }
}

/**
 * Metadata for an `email_logs` row. `messageId` is the provider's delivery id
 * (not a secret) and is kept explicitly even though its name would otherwise
 * be innocuous; template data is redacted. `serverMessageId` (the relay's
 * queue id) and `category` (transactional, notification, marketing) are kept
 * when the send had them, so a row can be matched with the relay's log.
 */
export function buildEmailLogMetadata(
  templateData: Record<string, string> | undefined,
  messageId: string | undefined,
  extra: { serverMessageId?: string; category?: string } = {},
): Record<string, unknown> {
  return {
    templateData: templateData ? redactSecrets(templateData) : undefined,
    messageId,
    ...(extra.serverMessageId ? { serverMessageId: extra.serverMessageId } : {}),
    ...(extra.category ? { category: extra.category } : {}),
  };
}

/**
 * The subject as `email_logs` keeps it. A template may print a credential in
 * its subject: the verification code's is "Your verification code: {code}",
 * and a shop's guest order lookup sends it with the shop's workspace, whose
 * owners read that log. Every value the metadata redaction would hide (a
 * credential-named key, a URL with a query) is cut out of the subject the
 * same way.
 */
export function redactEmailLogSubject(subject: string, templateData: Record<string, string> | undefined): string {
  let out = String(subject ?? '');
  for (const [key, value] of Object.entries(templateData ?? {})) {
    const text = value == null ? '' : String(value);
    if (text.length < 3) continue;
    if (SENSITIVE_KEY.test(key) || URL_WITH_PARAMS.test(text)) out = out.split(text).join(REDACTED);
  }
  return out;
}

/** The only shape `email_logs.error_message` holds since 2026-10-29: "<errorCode>: <short reason>". */
const SAFE_ERROR = /^(unconfigured|invalid_recipient|suppressed|timeout|connection|auth|rejected|provider_error|template_missing|edition_unavailable): /;

/**
 * An older row's error, as a workspace may see it. Before the codes, a row
 * held the provider's own text ("SMTP error: connect ECONNREFUSED
 * 172.18.0.5:587", a relay's reply): internal names and addresses that are
 * nobody's business outside the platform. Anything not in today's shape
 * reads as a generic provider error.
 */
export function redactEmailLogError(message: unknown): string | null {
  if (message == null || message === '') return null;
  const text = String(message);
  return SAFE_ERROR.test(text) ? text : 'provider_error: the provider refused or failed (details are in the server log)';
}

/**
 * A digit run in an older row's subject, when its template data had a code:
 * the row's own value was never kept (the metadata holds [REDACTED]), so the
 * subject's code is found by its shape.
 */
const CODE_IN_SUBJECT = /\d{4,10}/g;
const CODE_KEY = /code|otp|(^|[_-])pin($|[_-])/i;

function hadCode(metadata: unknown): boolean {
  const data = (metadata as { templateData?: unknown } | null)?.templateData;
  if (!isPlainObject(data)) return false;
  return Object.keys(data).some((key) => CODE_KEY.test(key));
}

/**
 * Redacts rows read back from `email_logs`: the `metadata`, the error (see
 * redactEmailLogError) and, for a row whose template data carried a code,
 * the code in its subject.
 */
export function redactEmailLogRows<T extends { metadata?: unknown }>(rows: T[] | null | undefined): T[] {
  return (rows ?? []).map((row) => {
    if (!row || typeof row !== 'object') return row;
    const out: Record<string, unknown> = { ...row };
    if ('metadata' in row) out.metadata = redactSecrets(row.metadata);
    if ('error_message' in out) out.error_message = redactEmailLogError(out.error_message);
    if (typeof out.subject === 'string' && hadCode(row.metadata)) out.subject = out.subject.replace(CODE_IN_SUBJECT, REDACTED);
    return out as T;
  });
}
