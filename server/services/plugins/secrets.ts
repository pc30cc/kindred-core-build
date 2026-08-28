/**
 * Encrypted plugin credential lifecycle.
 *
 * The browser sends a credential exactly once and never receives it again —
 * every API surface returns only `hasToken: true`. Fails closed when
 * PLUGIN_SECRETS_MASTER_KEY is absent; never falls back to plaintext.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import {
  decryptPluginSecret,
  encryptPluginSecret,
  isPluginCryptoConfigured,
  PluginCryptoUnavailableError,
} from '../../lib/pluginCrypto.js';

export const TELEGRAM_BOT_TOKEN_KEY = 'telegram_bot_token';
/**
 * Staging slot for an atomic credential replacement. A new token lives here
 * for the duration of the connect lifecycle and is PROMOTED to
 * TELEGRAM_BOT_TOKEN_KEY only after full provider verification, so a failed
 * "Replace token" can never destroy a working credential.
 */
export const TELEGRAM_BOT_TOKEN_PENDING_KEY = 'telegram_bot_token_pending';

export function pluginCryptoReady(config: ServerConfig): boolean {
  return isPluginCryptoConfigured(config.pluginSecretsMasterKey);
}

export async function storePluginSecret(
  config: ServerConfig,
  installationId: string,
  secretKey: string,
  plaintext: string,
): Promise<void> {
  const envelope = encryptPluginSecret(plaintext, config.pluginSecretsMasterKey);
  const sb = getServiceClient(config);
  const { error } = await sb.from('plugin_secrets').upsert(
    {
      installation_id: installationId,
      secret_key: secretKey,
      ...envelope,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'installation_id,secret_key' },
  );
  if (error) throw new Error(`plugin secret write failed: ${error.message}`);
}

export async function readPluginSecret(
  config: ServerConfig,
  installationId: string,
  secretKey: string,
): Promise<string | null> {
  if (!pluginCryptoReady(config)) throw new PluginCryptoUnavailableError();
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('plugin_secrets')
    .select('algorithm,nonce,ciphertext,auth_tag')
    .eq('installation_id', installationId)
    .eq('secret_key', secretKey)
    .maybeSingle();
  if (error) throw new Error(`plugin secret read failed: ${error.message}`);
  if (!data) return null;
  return decryptPluginSecret(data as any, config.pluginSecretsMasterKey);
}

export async function hasPluginSecret(
  config: ServerConfig,
  installationId: string,
  secretKey: string,
): Promise<boolean> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('plugin_secrets')
    .select('id')
    .eq('installation_id', installationId)
    .eq('secret_key', secretKey)
    .maybeSingle();
  if (error) throw new Error(`plugin secret probe failed: ${error.message}`);
  return !!data;
}

export async function deletePluginSecret(
  config: ServerConfig,
  installationId: string,
  secretKey: string,
): Promise<void> {
  const sb = getServiceClient(config);
  const { error } = await sb
    .from('plugin_secrets')
    .delete()
    .eq('installation_id', installationId)
    .eq('secret_key', secretKey);
  if (error) throw new Error(`plugin secret delete failed: ${error.message}`);
}

/**
 * Backup slot used during an atomic credential replacement. The LIVE token is
 * copied here (ciphertext only, never decrypted) immediately before promotion
 * so a failed state transition can restore it byte-for-byte.
 */
export const TELEGRAM_BOT_TOKEN_PREVIOUS_KEY = 'telegram_bot_token_previous';

/**
 * Moves an encrypted credential from one slot to another WITHOUT decrypting
 * it — the ciphertext envelope is copied as-is.
 *
 * This is what makes credential promotion possible on a Core that must not
 * (and, in a restricted-network deployment, cannot) do anything with the
 * plaintext: no master-key use, no provider call, one row write.
 *
 * Returns false when the source slot is empty.
 */
export async function copyPluginSecret(
  config: ServerConfig,
  installationId: string,
  fromKey: string,
  toKey: string,
): Promise<boolean> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('plugin_secrets')
    .select('algorithm,nonce,ciphertext,auth_tag')
    .eq('installation_id', installationId)
    .eq('secret_key', fromKey)
    .maybeSingle();
  if (error) throw new Error(`plugin secret copy read failed: ${error.message}`);
  if (!data) return false;

  const { error: writeError } = await sb.from('plugin_secrets').upsert(
    {
      installation_id: installationId,
      secret_key: toKey,
      ...(data as Record<string, unknown>),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'installation_id,secret_key' },
  );
  if (writeError) throw new Error(`plugin secret copy write failed: ${writeError.message}`);
  return true;
}
