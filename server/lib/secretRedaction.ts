/**
 * Credentials out of a stored provider value before it reaches a browser,
 * and back in on a save from a form that never received them. One rule for
 * every Super Admin read of stored settings: runtime config
 * (server/routes/adminManagement.ts), the billing gateways' credentials
 * (server/routes/adminBilling.ts) and the workspaces' provider configs.
 */

/**
 * A field whose value is a credential. Broad on purpose, as in the storage
 * pool's route: one field too many costs the Super Admin a blank input, one
 * too few a leaked password. A bare `key` (a pre-chat field's own key) is
 * not one; `api_key` and `access_key_id` are, and so are the connection
 * strings that carry a password (`database_url`, `connection_string`) and
 * Telegram's `api_hash`.
 */
const SECRET_FIELD = /pass(word|wd)?|secret|token|credential|private|merchant|service_account|apikey|api_hash|database_url|connection_string|.+_key(_|$)/i;

/**
 * Names the pattern above catches that are not credentials, in the provider
 * forms (src/features/providers/schemas.ts) as ordinary inputs: a number of
 * tokens or seconds, and the keys a vendor makes public by design (a
 * publishable or anon key, a captcha site key, a search-only key, a webhook's
 * public key, Paddle's client-side token), which sit in the page or the
 * browser bundle anyway. Hidden,
 * they showed as saved with an empty input that could never be cleared.
 */
const NOT_SECRET_FIELD = /^(max_tokens|token_ttl_seconds|site_key|search_key|supabase_anon_key|anon_key|client_token)$|(^|_)public(_|$)|publishable/i;

/**
 * A URL with a password in it (`redis://user:pass@host`), whatever the field
 * is called: the Redis and Dragonfly forms take their password that way.
 */
const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s@:]*:[^/?#\s@]+@/i;

function isSecretField(field: string, value: unknown): boolean {
  if (typeof value === 'string' && URL_WITH_PASSWORD.test(value.trim())) return true;
  return SECRET_FIELD.test(field) && !NOT_SECRET_FIELD.test(field);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A value worth hiding: text, a number, or a filled object (an encrypted envelope, a key file). */
function holdsValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return false;
}

/**
 * A runtime-config value as the browser may see it: every credential-looking
 * field at any depth left out, and its path (`config.api_key`) listed in
 * `secretKeysSet` so a form can show it as saved. These rows used to come
 * back whole, the relay's password and the old Resend key included.
 */
export function redactRuntimeConfigValue(value: unknown): { value: unknown; secretKeysSet: string[] } {
  const secretKeysSet: string[] = [];
  const walk = (node: unknown, path: string[]): unknown => {
    if (Array.isArray(node)) return node.map((item, i) => walk(item, [...path, String(i)]));
    if (!isPlainObject(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [field, child] of Object.entries(node)) {
      if (isSecretField(field, child) && holdsValue(child)) {
        secretKeysSet.push([...path, field].join('.'));
        continue;
      }
      out[field] = walk(child, [...path, field]);
    }
    return out;
  };
  return { value: walk(value, []), secretKeysSet };
}

function providerIdentity(value: Record<string, unknown>): string {
  return String(value.provider_name ?? value.provider ?? '').trim().toLowerCase();
}

/**
 * The value to store for a save from a form that never received the
 * credentials: a credential the save leaves blank or out keeps the stored
 * one, at any depth of nested objects, but only while the provider is the
 * same (two vendors may both call theirs `api_key`, and one's key must never
 * be sent to the other). Arrays are taken as sent. Everything else is the
 * save's own.
 */
export function keepStoredRuntimeSecrets(stored: unknown, incoming: unknown): unknown {
  if (!isPlainObject(stored) || !isPlainObject(incoming)) return incoming;
  if (providerIdentity(stored) !== providerIdentity(incoming)) return incoming;
  const out: Record<string, unknown> = { ...incoming };
  for (const [field, kept] of Object.entries(stored)) {
    if (isSecretField(field, kept)) {
      if (holdsValue(kept) && !holdsValue(incoming[field])) out[field] = kept;
    } else if (isPlainObject(kept) && isPlainObject(incoming[field])) {
      out[field] = keepStoredRuntimeSecrets(kept, incoming[field]);
    }
  }
  return out;
}
