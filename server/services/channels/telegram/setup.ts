/**
 * Telegram connection lifecycle: validate token → register webhook →
 * activate integration. Runs in Core only (it needs the master key to read
 * the encrypted bot token).
 */

import type { ServerConfig } from '../../../config.js';
import { deriveChannelWebhookSecret } from '../../../../shared/channels/webhookSecret.js';
import { TELEGRAM_BOT_TOKEN_KEY, readPluginSecret } from '../../plugins/secrets.js';
import {
  buildWebhookUrl,
  getIntegrationForInstallation,
  updateIntegration,
  type ChannelIntegration,
} from '../integrations.js';
import { deleteWebhook, getMe, getWebhookInfo, redactToken, setWebhook } from './client.js';

export async function connectTelegramBot(
  config: ServerConfig,
  integration: ChannelIntegration,
  botToken: string,
): Promise<{ bot: { id: number; username: string | null } }> {
  const signingKey = config.channelsWebhookSigningKey;
  if (!signingKey) throw new Error('CHANNELS_WEBHOOK_SIGNING_KEY is not configured');

  try {
    const bot = await getMe(botToken);
    const url = buildWebhookUrl(config, 'telegram', integration.public_integration_id);
    const secretToken = deriveChannelWebhookSecret(signingKey, 'telegram', integration.public_integration_id);

    await setWebhook(botToken, url, secretToken);

    await updateIntegration(config, integration.id, {
      status: 'active',
      external_account_id: String(bot.id),
      external_account_name: bot.username,
      webhook_registered_at: new Date().toISOString(),
      last_error: null,
    });

    return { bot: { id: bot.id, username: bot.username } };
  } catch (err) {
    const message = redactToken(err instanceof Error ? err.message : String(err));
    await updateIntegration(config, integration.id, { status: 'error', last_error: message.slice(0, 500) });
    throw new Error(message);
  }
}

export async function disconnectTelegramBot(config: ServerConfig, installationId: string): Promise<void> {
  const integration = await getIntegrationForInstallation(config, installationId);
  if (!integration) return;

  try {
    const token = await readPluginSecret(config, installationId, TELEGRAM_BOT_TOKEN_KEY);
    if (token) await deleteWebhook(token);
  } catch (err) {
    // Provider cleanup is best-effort; local revocation must still proceed.
    console.warn('[telegram] webhook removal failed during disconnect:', redactToken(String(err)));
  }

  await updateIntegration(config, integration.id, {
    status: 'revoked',
    webhook_registered_at: null,
    last_error: null,
  });
}

/**
 * Compares what Telegram believes about the webhook with what this server
 * expects. Never returns the token or the derived secret.
 */
export async function telegramDiagnostics(config: ServerConfig, installationId: string) {
  const integration = await getIntegrationForInstallation(config, installationId);
  if (!integration) return { connected: false as const, reason: 'no_integration' };

  const token = await readPluginSecret(config, installationId, TELEGRAM_BOT_TOKEN_KEY);
  if (!token) return { connected: false as const, reason: 'no_token' };

  const expectedUrl = config.publicChannelsBaseUrl
    ? buildWebhookUrl(config, 'telegram', integration.public_integration_id)
    : null;

  const info = await getWebhookInfo(token);
  return {
    connected: true as const,
    webhookUrl: info.url || null,
    expectedWebhookUrl: expectedUrl,
    webhookMatches: !!expectedUrl && info.url === expectedUrl,
    pendingUpdateCount: info.pending_update_count ?? 0,
    lastErrorMessage: info.last_error_message ? redactToken(info.last_error_message) : null,
    lastErrorAt: info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : null,
    lastInboundAt: integration.last_inbound_at,
    integrationStatus: integration.status,
  };
}
