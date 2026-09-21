/**
 * SIP credential storage. Thin wrapper over the EXISTING encrypted plugin
 * secret store (AES-256-GCM, PLUGIN_SECRETS_MASTER_KEY) — no new crypto, no
 * new key, no plaintext fallback.
 *
 * The password is write-only from every API's point of view: it is sent to
 * the trusted Telephony Control Service when a registration is provisioned,
 * and to nowhere else. It never reaches a browser and never enters a log.
 */

import type { ServerConfig } from '../../config.js';
import {
  deletePluginSecret,
  hasPluginSecret,
  pluginCryptoReady,
  readPluginSecret,
  storePluginSecret,
} from '../plugins/secrets.js';

export const DAFTARESHOMA_SIP_PASSWORD_KEY = 'daftareshoma_sip_password';
/** Reserved for a future REST/Core API adapter; not required by the SIP MVP. */
export const DAFTARESHOMA_API_TOKEN_KEY = 'daftareshoma_api_token';

export function telephonyCryptoReady(config: ServerConfig): boolean {
  return pluginCryptoReady(config);
}

export async function storeSipPassword(
  config: ServerConfig,
  installationId: string,
  plaintext: string,
): Promise<void> {
  await storePluginSecret(config, installationId, DAFTARESHOMA_SIP_PASSWORD_KEY, plaintext);
}

/** Only the server-side provisioning path may call this. */
export async function readSipPassword(
  config: ServerConfig,
  installationId: string,
): Promise<string | null> {
  return readPluginSecret(config, installationId, DAFTARESHOMA_SIP_PASSWORD_KEY);
}

export async function hasSipPassword(
  config: ServerConfig,
  installationId: string,
): Promise<boolean> {
  return hasPluginSecret(config, installationId, DAFTARESHOMA_SIP_PASSWORD_KEY);
}

export async function deleteSipPassword(
  config: ServerConfig,
  installationId: string,
): Promise<void> {
  await deletePluginSecret(config, installationId, DAFTARESHOMA_SIP_PASSWORD_KEY);
}
