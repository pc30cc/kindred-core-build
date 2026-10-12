/**
 * Shared transport rules for the payment gateways that have no SDK of their
 * own here (every one but ZarinPal and Paddle, which keep theirs).
 *
 *   - every call gives up after PROVIDER_TIMEOUT_MS: a gateway that does not
 *     answer (IDPay and SEP did not, from the production server) fails the
 *     checkout with a message instead of holding the customer's page; SEP's
 *     verify waits PROVIDER_VERIFY_TIMEOUT_MS (see there);
 *   - an answer that is not JSON (an HTML error page, a WAF) is reported with
 *     the gateway's name and the HTTP status, never as "Unexpected token '<'";
 *   - a stored switch is ON only for an explicit true / 'true' / '1' / 'on' /
 *     'yes': the Providers screen saves toggles as strings, and the string
 *     'false' is truthy (the defect that sent live ZarinPal to its sandbox).
 */

/** Every gateway call gives up after this long (create, test, lookups). */
export const PROVIDER_TIMEOUT_MS = 20_000;

/**
 * A verify that takes the money and cannot be asked again waits this long
 * instead (SEP: a second VerifyTransaction only answers "already verified",
 * which names no amount we can trust, and SEP never undoes a verify). Giving
 * up early there would leave a paid payment uncredited.
 */
export const PROVIDER_VERIFY_TIMEOUT_MS = 120_000;

/** A stored on/off setting, read strictly ('false', '0', '' and anything unknown are off). */
export function isSettingOn(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  return ['true', '1', 'on', 'yes'].includes(value.trim().toLowerCase());
}

/** A stored text setting, trimmed; '' when missing or not a string / number. */
export function settingText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/**
 * The labels of the required settings that are empty, as "A, B are empty."
 * (null when none is). `fields` is [config key, label shown in Providers].
 */
export function missingSettings(
  gateway: string,
  config: Record<string, unknown> | null | undefined,
  fields: ReadonlyArray<readonly [string, string]>,
): string | null {
  const missing = fields.filter(([key]) => !settingText(config?.[key])).map(([, label]) => label);
  if (missing.length === 0) return null;
  return `${gateway}: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} empty.`;
}

/** `fetch` with a deadline. A timeout throws "<gateway> gateway unreachable: no answer within N s". */
export async function providerFetch(
  gateway: string,
  url: string,
  init: RequestInit = {},
  timeoutMs: number = PROVIDER_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted) {
      throw new Error(`${gateway} gateway unreachable: no answer within ${Math.round(timeoutMs / 1000)} s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The JSON body of a gateway answer. A body that is not JSON throws a
 * descriptive error (gateway, context, HTTP status, a short snippet).
 * An empty body is `null`.
 */
export async function readProviderJson(gateway: string, res: Response, context: string): Promise<unknown> {
  // Test doubles sometimes give only json(); a real Response has both.
  if (typeof (res as { text?: unknown }).text !== 'function') return (res as { json: () => Promise<unknown> }).json();
  const text = (await res.text()).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(
      `${gateway} gateway unreachable: ${context} returned a non-JSON response (HTTP ${res.status})`
      + (snippet ? `: ${snippet}` : ''),
    );
  }
}

/** The https callback the Test button passes (`config.probe_callback_url`), else a placeholder. */
export function probeCallbackUrl(config: Record<string, unknown>): string {
  const url = config.probe_callback_url;
  return typeof url === 'string' && /^https:\/\//i.test(url) ? url : 'https://test.localhost/callback';
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
