/**
 * The code of a refused request on the AI section's test tools (Regression
 * runs, Suggested tests, the retrieval debugger): AiAgentApiError keeps it in
 * `code`, its message is the same code or `request_failed_<status>`. The
 * pages turn it into a sentence in the panel's language, never show it.
 */
export function apiErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const record = error as { code?: unknown; message?: unknown };
  if (typeof record.code === 'string' && record.code) return record.code;
  return typeof record.message === 'string' ? record.message : '';
}

/** A sentence for the code from `own` (the page's codes), else the shared fallback. */
export function pickErrorText(error: unknown, own: Record<string, string>, fallback: (error: unknown) => string): string {
  const code = apiErrorCode(error);
  if (Object.prototype.hasOwnProperty.call(own, code)) return own[code];
  const prefix = code.split(':')[0];
  if (prefix !== code && Object.prototype.hasOwnProperty.call(own, prefix)) return own[prefix];
  return fallback(error);
}
