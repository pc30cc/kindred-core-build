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
