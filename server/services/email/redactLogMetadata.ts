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
    if (SENSITIVE_KEY.test(key) && value !== null && value !== undefined && value !== '') {
      out[key] = REDACTED;
    } else {
      out[key] = redactValue(value, depth);
    }
  }
  return out;
}

/**
 * Returns a deep copy of `value` with every credential-looking field replaced
 * by `[REDACTED]`. Non-object input is returned unchanged (after URL check).
 * Never throws.
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
 * be innocuous; template data is redacted.
 */
export function buildEmailLogMetadata(
  templateData: Record<string, string> | undefined,
  messageId: string | undefined,
): Record<string, unknown> {
  return {
    templateData: templateData ? redactSecrets(templateData) : undefined,
    messageId,
  };
}

/** Redacts the `metadata` field of rows read back from `email_logs`. */
export function redactEmailLogRows<T extends { metadata?: unknown }>(rows: T[] | null | undefined): T[] {
  return (rows ?? []).map((row) =>
    row && 'metadata' in row ? { ...row, metadata: redactSecrets(row.metadata) } : row,
  );
}
