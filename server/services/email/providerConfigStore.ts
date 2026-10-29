// ============================================
// EMAIL PROVIDER CONFIG STORE
// ============================================
//
// The platform's email transport lives in two `app_runtime_config` rows:
// `default_email_provider` (every mail) and `notification_email_provider`
// (the operator notification mails, when Super Admin → Notifications points
// them elsewhere). Both hold the same shape:
//
//   { provider_name, config: { …fields that are not secret },
//                    secrets: { <field>: <AES-256-GCM envelope> } }
//
// This module is the only reader and writer of that shape. It reads every
// row written so far unchanged: today's production rows carry every field,
// the relay password and the old Resend key included, in plain text under
// `config`, and they keep sending exactly as they did. A secret is encrypted
// (server/lib/pluginCrypto.ts, PLUGIN_SECRETS_MASTER_KEY) when the row is
// next written, and from then on it never sits in clear in the database or
// in the daily dumps of it. A secret is never handed back to a browser: the
// Super Admin learns only which ones are set.

import type { ServerConfig } from '../../config.js';
import { serviceClientFor } from '../../lib/serviceClient.js';
import {
  PLUGIN_SECRET_ALGORITHM,
  decryptPluginSecret,
  encryptPluginSecret,
  isPluginCryptoConfigured,
} from '../../lib/pluginCrypto.js';
import { insertAuditLogRows } from '../auditLog.js';
import {
  EMAIL_PROVIDER_COMMON_FIELDS,
  EMAIL_PROVIDER_FIELDS,
  EMAIL_PROVIDER_SECRET_FIELDS,
  canonicalEmailProviderConfig,
  emailProviderConfigProblems,
  isEmailProviderAdapter,
} from '../../../shared/emailProviders.js';
import {
  describeEmailProviderProblem,
  effectiveEmailProviderConfig,
  emailProviderProblems,
  getEmailAdapter,
} from './providers/index.js';
import type { EmailProviderVerifyResult, ProviderConfig } from './providers/types.js';

export const EMAIL_PROVIDER_KEYS = ['default_email_provider', 'notification_email_provider'] as const;
export type EmailProviderKey = typeof EMAIL_PROVIDER_KEYS[number];

export function isEmailProviderKey(key: unknown): key is EmailProviderKey {
  return typeof key === 'string' && (EMAIL_PROVIDER_KEYS as readonly string[]).includes(key);
}

/** An encrypted secret as it is stored. */
interface StoredSecret {
  algorithm: string;
  key_version: number;
  nonce: string;
  ciphertext: string;
  auth_tag: string;
}

/**
 * Secret-looking names, for a row whose provider has no adapter here (an
 * older form's vendor) or a field no adapter declares: such a value is
 * treated as a secret too, so it never reaches a browser either.
 */
const SECRET_NAME = /pass|secret|token|api_?key|private|credential/i;

/** Longest value a field may hold: far beyond any real key, password or name. */
const MAX_VALUE_LENGTH = 2048;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isStoredSecret(value: unknown): value is StoredSecret {
  const v = value as Partial<StoredSecret> | null;
  return !!v && typeof v === 'object' && typeof v.algorithm === 'string' && typeof v.nonce === 'string'
    && typeof v.ciphertext === 'string' && typeof v.auth_tag === 'string';
}

function isSet(value: unknown): boolean {
  return isStoredSecret(value) || (typeof value === 'string' && value.trim() !== '') || typeof value === 'number';
}

function providerNameOf(row: Record<string, unknown>): string {
  return String(row.provider_name || row.provider || '').trim().toLowerCase();
}

function isSecretField(providerName: string, field: string): boolean {
  if (isEmailProviderAdapter(providerName) && EMAIL_PROVIDER_SECRET_FIELDS[providerName].includes(field)) return true;
  return SECRET_NAME.test(field);
}

/**
 * The stored row's fields as one record in today's names, secrets still as
 * stored (an envelope, or plain text in an older row). `secrets` wins over
 * `config` for a field in both.
 */
function storedFields(row: Record<string, unknown>): Record<string, unknown> {
  return canonicalEmailProviderConfig(providerNameOf(row), { ...asRecord(row.config), ...asRecord(row.secrets) });
}

/**
 * The encrypted form of a secret. The envelope's fingerprint (an unsalted
 * hash of the plain text) is left out: of a password it is a guessing oracle
 * for anyone holding a dump, and nothing here needs it.
 */
function sealSecret(plaintext: string, masterKey: string | undefined): StoredSecret {
  const { algorithm, key_version, nonce, ciphertext, auth_tag } = encryptPluginSecret(plaintext, masterKey);
  return { algorithm, key_version, nonce, ciphertext, auth_tag };
}

function openSecret(secret: StoredSecret, masterKey: string | undefined): string | null {
  if (secret.algorithm !== PLUGIN_SECRET_ALGORITHM) return null;
  try {
    return decryptPluginSecret(secret, masterKey);
  } catch {
    return null;
  }
}

/**
 * A stored row as the send path reads it: every secret in clear (decrypted,
 * or plain in an older row), merged with the rest. A secret that cannot be
 * decrypted (no PLUGIN_SECRETS_MASTER_KEY, or a different one) is left out,
 * so the provider reads as missing it and fails as `unconfigured` instead of
 * signing in with garbage; the console says which field, never its value.
 */
export function decodeEmailProviderRow(
  value: unknown,
  masterKey: string | undefined,
  label = 'email provider',
): ProviderConfig | null {
  const row = asRecord(value);
  const providerName = providerNameOf(row);
  if (!providerName || providerName === 'disabled') return null;
  const fields = storedFields(row);
  for (const [field, stored] of Object.entries(fields)) {
    if (!isStoredSecret(stored)) continue;
    const plain = openSecret(stored, masterKey);
    if (plain === null) {
      console.warn(`[email] ${label}: the stored ${field} cannot be decrypted (PLUGIN_SECRETS_MASTER_KEY missing or changed)`);
      delete fields[field];
    } else {
      fields[field] = plain;
    }
  }
  return { provider_name: providerName, config: fields };
}

export type LoadedEmailProvider =
  | { status: 'ok'; provider: ProviderConfig }
  | { status: 'none' }
  | { status: 'error'; message: string };

function client(config: ServerConfig) {
  return serviceClientFor(config.supabaseUrl, config.supabaseServiceRoleKey);
}

type RowRead = { ok: true; value: unknown; message?: undefined } | { ok: false; value?: undefined; message: string };

async function readRow(config: ServerConfig, key: EmailProviderKey): Promise<RowRead> {
  try {
    const { data, error } = await client(config)
      .from('app_runtime_config')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error) return { ok: false, message: error.message };
    return { ok: true, value: (data as { value?: unknown } | null)?.value ?? null };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The provider a row names, telling "no provider" (none, or `disabled`)
 * apart from "the setting could not be read": the first is a configuration
 * fault, the second a blip a retry gets past.
 */
export async function loadEmailProviderConfig(config: ServerConfig, key: EmailProviderKey): Promise<LoadedEmailProvider> {
  const read = await readRow(config, key);
  if (!read.ok) return { status: 'error', message: read.message };
  const provider = decodeEmailProviderRow(read.value, config.pluginSecretsMasterKey, key);
  return provider ? { status: 'ok', provider } : { status: 'none' };
}

/** The provider a row names, secrets decrypted; null when there is none or it cannot be read. */
export async function readEmailProviderConfig(config: ServerConfig, key: EmailProviderKey): Promise<ProviderConfig | null> {
  const loaded = await loadEmailProviderConfig(config, key);
  if (loaded.status === 'error') console.warn(`[email] ${key} lookup failed:`, loaded.message);
  return loaded.status === 'ok' ? loaded.provider : null;
}

/**
 * The row for the Super Admin's form: the provider, every field that is not
 * a secret, and the names of the secrets that are set. Never a secret's
 * value, encrypted or not.
 */
export async function readEmailProviderForAdmin(config: ServerConfig, key: EmailProviderKey): Promise<{
  provider_name: string | null;
  config: Record<string, unknown>;
  secretKeysSet: string[];
}> {
  const read = await readRow(config, key);
  if (!read.ok) throw new Error(`email_provider_read_failed: ${read.message}`);
  const row = asRecord(read.value);
  const providerName = providerNameOf(row);
  const publicConfig: Record<string, unknown> = {};
  const secretKeysSet: string[] = [];
  for (const [field, value] of Object.entries(storedFields(row))) {
    if (isStoredSecret(value) || isSecretField(providerName, field)) {
      if (isSet(value)) secretKeysSet.push(field);
    } else {
      publicConfig[field] = value;
    }
  }
  return { provider_name: providerName || null, config: publicConfig, secretKeysSet: secretKeysSet.sort() };
}

type WriteResult = { ok: true } | { ok: false; error: string; field?: string };

/**
 * Saves a provider for `key`, from the Super Admin's form.
 *
 *   - `provider_name` must be one this server has an adapter for, or
 *     `disabled`, which removes the row (mail then has no provider, or, for
 *     the notification key, goes out the default one).
 *   - Only the provider's own fields and the common ones are taken (older
 *     names fold into today's); anything else is refused, never kept.
 *   - A secret left blank or absent keeps the stored one, when the provider
 *     is the same; switching provider never carries a secret across (Resend
 *     and SendGrid both call theirs api_key).
 *   - A new secret is stored encrypted; without PLUGIN_SECRETS_MASTER_KEY it
 *     is refused rather than stored in clear. A kept one from an older row
 *     is encrypted now when the key is there.
 *   - The result must be able to send (its required fields, a valid
 *     from_email): a config that cannot is refused with the field.
 *   - An `audit_logs` row records who changed what: the provider and the
 *     names of the fields that changed, never a value.
 */
export async function writeEmailProviderConfig(
  config: ServerConfig,
  key: EmailProviderKey,
  input: { provider_name: string; config: Record<string, unknown> },
  actor: { userId: string },
): Promise<WriteResult> {
  if (!isEmailProviderKey(key)) return { ok: false, error: 'unknown_key' };
  const name = String(input?.provider_name ?? '').trim().toLowerCase();
  const sb = client(config);

  const prior = await readRow(config, key);
  if (!prior.ok) return { ok: false, error: 'storage_error' };
  const priorRow = asRecord(prior.value);
  const priorName = providerNameOf(priorRow);

  const audit = async (providerName: string, changedFields: string[]) => {
    const { error } = await insertAuditLogRows(config, sb, {
      workspace_id: null,
      user_id: actor?.userId ?? null,
      action: 'admin.email_provider.changed',
      entity_type: 'app_runtime_config',
      entity_id: null,
      old_value: { key, provider_name: priorName || null },
      new_value: { key, provider_name: providerName, changed_fields: changedFields },
    });
    if (error) console.warn(`[email] ${key} change was saved but not audited:`, error.message);
  };

  if (name === 'disabled') {
    const { error } = await sb.from('app_runtime_config').delete().eq('key', key);
    if (error) return { ok: false, error: 'storage_error' };
    await audit('disabled', priorName ? ['provider_name'] : []);
    return { ok: true };
  }
  if (!isEmailProviderAdapter(name)) return { ok: false, error: 'unknown_provider', field: 'provider_name' };
  if (input.config !== undefined && (typeof input.config !== 'object' || input.config === null || Array.isArray(input.config))) {
    return { ok: false, error: 'invalid_field', field: 'config' };
  }

  const allowed = new Set<string>([...EMAIL_PROVIDER_COMMON_FIELDS, ...EMAIL_PROVIDER_FIELDS[name]]);
  const secretFields = EMAIL_PROVIDER_SECRET_FIELDS[name];
  const nextConfig: Record<string, string> = {};
  const typedSecrets: Record<string, string> = {};
  for (const [field, raw] of Object.entries(canonicalEmailProviderConfig(name, asRecord(input.config)))) {
    if (!allowed.has(field)) return { ok: false, error: 'unknown_field', field };
    if (raw === null || raw === undefined) continue;
    if (secretFields.includes(field)) {
      if (typeof raw !== 'string' || raw.length > MAX_VALUE_LENGTH) return { ok: false, error: 'invalid_field', field };
      if (raw.trim()) typedSecrets[field] = raw;
      continue;
    }
    if (typeof raw !== 'string' && typeof raw !== 'number') return { ok: false, error: 'invalid_field', field };
    const value = String(raw).trim();
    if (value.length > MAX_VALUE_LENGTH) return { ok: false, error: 'invalid_field', field };
    if (value) nextConfig[field] = field === 'encryption' ? value.toLowerCase() : value;
  }

  const masterKey = config.pluginSecretsMasterKey;
  const canEncrypt = isPluginCryptoConfigured(masterKey);
  const sameProvider = priorName === name;
  const priorFields = sameProvider ? storedFields(priorRow) : {};
  const secrets: Record<string, unknown> = {};
  const changed = new Set<string>();
  if (!sameProvider) changed.add('provider_name');

  for (const field of secretFields) {
    const kept = priorFields[field];
    if (field in typedSecrets) {
      if (!canEncrypt) return { ok: false, error: 'encryption_unavailable', field };
      secrets[field] = sealSecret(typedSecrets[field], masterKey);
      const before = isStoredSecret(kept) ? openSecret(kept, masterKey) : typeof kept === 'string' ? kept : null;
      if (before !== typedSecrets[field]) changed.add(field);
    } else if (isStoredSecret(kept)) {
      const { algorithm, key_version, nonce, ciphertext, auth_tag } = kept;
      secrets[field] = { algorithm, key_version, nonce, ciphertext, auth_tag };
    } else if (typeof kept === 'string' && kept.trim()) {
      // An older row's plain secret, kept as the form left it blank:
      // encrypted now when it can be, else kept as it was (never refused,
      // so a sender name can still be changed without the key).
      secrets[field] = canEncrypt ? sealSecret(kept, masterKey) : kept;
    }
  }

  for (const field of allowed) {
    if (secretFields.includes(field)) continue;
    const before = sameProvider && !isSecretField(name, field) ? String(priorFields[field] ?? '').trim() : '';
    if (before !== (nextConfig[field] ?? '')) changed.add(field);
  }

  // Presence stands in for the secrets' values: whether a credential is
  // right is the provider's test (verify), not this one's.
  const presence: Record<string, unknown> = { ...nextConfig };
  for (const field of Object.keys(secrets)) presence[field] = 'set';
  const problems = emailProviderConfigProblems(name, presence, process.env);
  if (problems.length) {
    const first = problems[0];
    return { ok: false, error: first.problem === 'missing' ? 'missing_field' : 'invalid_field', field: first.field };
  }

  const value: Record<string, unknown> = { provider_name: name, config: nextConfig };
  if (Object.keys(secrets).length) value.secrets = secrets;
  const { error } = await sb
    .from('app_runtime_config')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) return { ok: false, error: 'storage_error' };
  await audit(name, [...changed].sort());
  return { ok: true };
}

/**
 * Connects to the provider and authenticates, without sending anything
 * (SMTP: transporter.verify(); Resend and SendGrid: an authenticated read).
 * The detail is safe to show the Super Admin.
 */
export async function verifyEmailProvider(config: ServerConfig, key: EmailProviderKey): Promise<EmailProviderVerifyResult> {
  const loaded = await loadEmailProviderConfig(config, key);
  if (loaded.status === 'error') return { ok: false, detail: 'provider_error: the email provider setting could not be read' };
  if (loaded.status === 'none') return { ok: false, detail: 'unconfigured: no email provider is set' };
  const adapter = getEmailAdapter(loaded.provider.provider_name);
  if (!adapter) return { ok: false, detail: 'unconfigured: the email provider has no adapter on this server' };
  const problems = emailProviderProblems(loaded.provider);
  if (problems.length) return { ok: false, detail: `unconfigured: ${describeEmailProviderProblem(problems[0])}` };
  if (!adapter.verify) return { ok: true, detail: 'this provider has no connection check; send a test mail instead' };
  try {
    return await adapter.verify(effectiveEmailProviderConfig(loaded.provider));
  } catch (err) {
    console.warn(`[email] ${key} check threw:`, err instanceof Error ? err.message : String(err));
    return { ok: false, detail: 'provider_error: the check failed' };
  }
}
