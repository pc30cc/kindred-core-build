/**
 * Commerce installation credential slots — thin wrapper over the EXISTING
 * plugin_secrets envelope (server/services/plugins/secrets.ts), reusing the
 * same `live` / `pending` / `previous` atomic-replace lifecycle the
 * Telegram connector uses. No new encryption or storage was built for
 * this — see docs/commerce/ARCHITECTURE.md's reuse table.
 */
import type { ServerConfig } from '../../config.js';
import {
  copyPluginSecret,
  deletePluginSecret,
  hasPluginSecret,
  readPluginSecret,
  storePluginSecret,
} from '../plugins/secrets.js';

export const COMMERCE_SECRET_SLOTS = {
  live: 'commerce_installation_secret',
  pending: 'commerce_installation_secret_pending',
  previous: 'commerce_installation_secret_previous',
} as const;

export async function storeInstallationSecret(config: ServerConfig, installationId: string, secret: string, slot: 'live' | 'pending' = 'live') {
  await storePluginSecret(config, installationId, COMMERCE_SECRET_SLOTS[slot], secret);
}

export async function readInstallationSecret(config: ServerConfig, installationId: string, slot: 'live' | 'pending' = 'live') {
  return readPluginSecret(config, installationId, COMMERCE_SECRET_SLOTS[slot]);
}

export async function hasInstallationSecret(config: ServerConfig, installationId: string, slot: 'live' | 'pending' = 'live') {
  return hasPluginSecret(config, installationId, COMMERCE_SECRET_SLOTS[slot]);
}

export async function deleteInstallationSecret(config: ServerConfig, installationId: string, slot: 'live' | 'pending' | 'previous') {
  await deletePluginSecret(config, installationId, COMMERCE_SECRET_SLOTS[slot]);
}

export async function promotePendingInstallationSecret(config: ServerConfig, installationId: string): Promise<boolean> {
  const hadLive = await hasInstallationSecret(config, installationId, 'live');
  if (hadLive) await copyPluginSecret(config, installationId, COMMERCE_SECRET_SLOTS.live, COMMERCE_SECRET_SLOTS.previous);
  const promoted = await copyPluginSecret(config, installationId, COMMERCE_SECRET_SLOTS.pending, COMMERCE_SECRET_SLOTS.live);
  if (promoted) {
    await deletePluginSecret(config, installationId, COMMERCE_SECRET_SLOTS.pending);
    await deletePluginSecret(config, installationId, COMMERCE_SECRET_SLOTS.previous);
  }
  return promoted;
}

export async function rotateInstallationSecret(config: ServerConfig, installationId: string, newSecret: string): Promise<void> {
  await storeInstallationSecret(config, installationId, newSecret, 'pending');
  await promotePendingInstallationSecret(config, installationId);
}

export async function revokeInstallationSecrets(config: ServerConfig, installationId: string): Promise<void> {
  await Promise.all([
    deletePluginSecret(config, installationId, COMMERCE_SECRET_SLOTS.live),
    deletePluginSecret(config, installationId, COMMERCE_SECRET_SLOTS.pending),
    deletePluginSecret(config, installationId, COMMERCE_SECRET_SLOTS.previous),
  ]);
}
