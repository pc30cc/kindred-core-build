/**
 * Telegram connection lifecycle.
 *
 * A bot is reported CONNECTED only after EVERY step below succeeds:
 *
 *   1. getMe                      — the token is real and the bot is alive
 *   2. duplicate bot_id claim     — DB unique invariant, concurrency safe
 *   3. token encrypted + staged   — AES-256-GCM, write-only
 *   4. setWebhook(secret_token)   — provider accepts our ingress
 *   5. getWebhookInfo             — provider CONFIRMS the exact URL
 *   6. no last_error_message      — provider is not already failing
 *
 * Any failure leaves the integration in `pending`/`error` and rolls back the
 * staged credential when the connection never succeeded — no ghost secrets
 * and no false "Connected" state.
 *
 * Runs in Core only (it needs the master key to read the encrypted token).
 */

import type { ServerConfig } from '../../../config.js';
import { deriveChannelWebhookSecret } from '../../../../shared/channels/webhookSecret.js';
import {
  TELEGRAM_BOT_TOKEN_KEY,
  deletePluginSecret,
  hasPluginSecret,
  readPluginSecret,
  storePluginSecret,
} from '../../plugins/secrets.js';
import {
  DuplicateProviderAccountError,
  buildWebhookUrl,
  claimProviderAccount,
  getIntegrationForInstallation,
  markIntegrationError,
  updateIntegration,
  type ChannelIntegration,
} from '../integrations.js';
import {
  deleteWebhook,
  getMe,
  getWebhookInfo,
  redactToken,
  setWebhook,
  setMyCommands,
  setMyDescription,
  setMyName,
  setMyShortDescription,
  type TelegramCommand,
} from './client.js';

export class TelegramConnectError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TelegramConnectError';
  }
}

export type TelegramConnectResult = {
  bot: { id: number; username: string | null; name: string | null };
  webhookUrl: string;
  verifiedAt: string;
};

/**
 * Full verified connect. `integration` must already exist (pending or a
 * previous disconnected/error record being reused).
 */
export async function connectTelegramBot(
  config: ServerConfig,
  integration: ChannelIntegration,
  botToken: string,
): Promise<TelegramConnectResult> {
  const signingKey = config.channelsWebhookSigningKey;
  if (!signingKey) throw new TelegramConnectError('not_configured', 'CHANNELS_WEBHOOK_SIGNING_KEY is not configured');

  const hadTokenBefore = await hasPluginSecret(config, integration.installation_id, TELEGRAM_BOT_TOKEN_KEY);
  const url = buildWebhookUrl(config, 'telegram', integration.public_integration_id);
  const secretToken = deriveChannelWebhookSecret(signingKey, 'telegram', integration.public_integration_id);

  const rollback = async (code: string, message: string): Promise<never> => {
    if (!hadTokenBefore) {
      // Never leave a credential behind for a connection that never worked.
      await deletePluginSecret(config, integration.installation_id, TELEGRAM_BOT_TOKEN_KEY).catch(() => {});
    }
    await markIntegrationError(config, integration.id, code).catch(() => {});
    throw new TelegramConnectError(code, redactToken(message).slice(0, 500));
  };

  // 1. Identity ─────────────────────────────────────────────────────────
  let bot;
  try {
    bot = await getMe(botToken);
  } catch (err) {
    return rollback('get_me_failed', err instanceof Error ? err.message : String(err));
  }

  // 2. Duplicate bot invariant (database-enforced) ──────────────────────
  try {
    await claimProviderAccount(config, integration, String(bot.id));
  } catch (err) {
    if (err instanceof DuplicateProviderAccountError) {
      await markIntegrationError(config, integration.id, 'duplicate_bot').catch(() => {});
      throw new TelegramConnectError('duplicate_bot', 'This Telegram bot is already connected to another workspace');
    }
    return rollback('account_claim_failed', err instanceof Error ? err.message : String(err));
  }

  // 3. Stage the credential (encrypted, write-only) ─────────────────────
  try {
    await storePluginSecret(config, integration.installation_id, TELEGRAM_BOT_TOKEN_KEY, botToken);
  } catch (err) {
    return rollback('credential_store_failed', err instanceof Error ? err.message : String(err));
  }

  // 4. Register the webhook ─────────────────────────────────────────────
  try {
    await setWebhook(botToken, url, secretToken);
  } catch (err) {
    return rollback('set_webhook_failed', err instanceof Error ? err.message : String(err));
  }
  await updateIntegration(config, integration.id, {
    webhook_registered_at: new Date().toISOString(),
    display_name: bot.firstName,
    username: bot.username,
  });

  // 5. Verify with the provider — the URL must match EXACTLY ────────────
  let info;
  try {
    info = await getWebhookInfo(botToken);
  } catch (err) {
    return rollback('get_webhook_info_failed', err instanceof Error ? err.message : String(err));
  }
  if (info.url !== url) {
    return rollback('webhook_url_mismatch', 'Telegram reports a different webhook URL than expected');
  }
  if (info.last_error_message && (info.last_error_date ?? 0) * 1000 > Date.now() - 60_000) {
    return rollback('webhook_provider_error', redactToken(info.last_error_message));
  }

  // 6. Only now is it connected ─────────────────────────────────────────
  const verifiedAt = new Date().toISOString();
  await updateIntegration(config, integration.id, {
    status: 'connected',
    external_account_id: String(bot.id),
    display_name: bot.firstName,
    username: bot.username,
    webhook_verified_at: verifiedAt,
    last_error_code: null,
    last_error_at: null,
  });

  return {
    bot: { id: bot.id, username: bot.username, name: bot.firstName },
    webhookUrl: url,
    verifiedAt,
  };
}

/**
 * Canonical disconnect: provider webhook removed (best effort, honestly
 * reported), credential destroyed, integration moved to `disconnected`.
 * Conversations and messages are historical data and are PRESERVED.
 */
export async function disconnectTelegramBot(
  config: ServerConfig,
  installationId: string,
): Promise<{ integration: boolean; webhookRemoved: boolean; webhookError: string | null }> {
  const integration = await getIntegrationForInstallation(config, installationId);

  let webhookRemoved = false;
  let webhookError: string | null = null;
  try {
    const token = await readPluginSecret(config, installationId, TELEGRAM_BOT_TOKEN_KEY);
    if (token) {
      await deleteWebhook(token);
      webhookRemoved = true;
    }
  } catch (err) {
    // Report honestly instead of pretending the provider was cleaned up.
    webhookError = redactToken(err instanceof Error ? err.message : String(err)).slice(0, 300);
    console.warn('[telegram] webhook removal failed during disconnect:', webhookError);
  }

  // Local acceptance is invalidated regardless of the provider outcome:
  // the credential is destroyed and the integration can no longer ingest.
  await deletePluginSecret(config, installationId, TELEGRAM_BOT_TOKEN_KEY).catch(() => {});

  if (!integration) return { integration: false, webhookRemoved, webhookError };

  await updateIntegration(config, integration.id, {
    status: 'disconnected',
    webhook_registered_at: null,
    webhook_verified_at: null,
    last_error_code: webhookError ? 'webhook_delete_failed' : null,
    last_error_at: webhookError ? new Date().toISOString() : null,
  });

  return { integration: true, webhookRemoved, webhookError };
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
    connected: integration.status === 'connected',
    webhookUrl: info.url || null,
    expectedWebhookUrl: expectedUrl,
    webhookMatches: !!expectedUrl && info.url === expectedUrl,
    pendingUpdateCount: info.pending_update_count ?? 0,
    lastErrorMessage: info.last_error_message ? redactToken(info.last_error_message) : null,
    lastErrorAt: info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : null,
    lastInboundAt: integration.last_inbound_at,
    lastOutboundAt: integration.last_outbound_at,
    integrationStatus: integration.status,
  };
}

/**
 * Re-registers the webhook for an already-credentialed integration.
 * Used by the `telegram_webhook_repair` job and the "Reconnect" action.
 */
export async function repairTelegramWebhook(
  config: ServerConfig,
  installationId: string,
): Promise<{ repaired: boolean; reason?: string }> {
  const signingKey = config.channelsWebhookSigningKey;
  if (!signingKey) return { repaired: false, reason: 'not_configured' };

  const integration = await getIntegrationForInstallation(config, installationId);
  if (!integration) return { repaired: false, reason: 'no_integration' };

  const token = await readPluginSecret(config, installationId, TELEGRAM_BOT_TOKEN_KEY);
  if (!token) return { repaired: false, reason: 'no_token' };

  const url = buildWebhookUrl(config, 'telegram', integration.public_integration_id);
  const secretToken = deriveChannelWebhookSecret(signingKey, 'telegram', integration.public_integration_id);

  try {
    await setWebhook(token, url, secretToken);
    const info = await getWebhookInfo(token);
    if (info.url !== url) {
      await markIntegrationError(config, integration.id, 'webhook_url_mismatch');
      return { repaired: false, reason: 'webhook_url_mismatch' };
    }
    await updateIntegration(config, integration.id, {
      status: 'connected',
      webhook_registered_at: new Date().toISOString(),
      webhook_verified_at: new Date().toISOString(),
      last_error_code: null,
      last_error_at: null,
    });
    return { repaired: true };
  } catch (err) {
    const message = redactToken(err instanceof Error ? err.message : String(err));
    await markIntegrationError(config, integration.id, 'webhook_repair_failed');
    return { repaired: false, reason: message.slice(0, 200) };
  }
}

export type TelegramProfilePatch = {
  name?: string | null;
  shortDescription?: string | null;
  description?: string | null;
  commands?: TelegramCommand[] | null;
};

/**
 * APPLY-ON-DEMAND bot branding. Never runs implicitly — only when an operator
 * explicitly presses "Apply to Telegram".
 */
export async function applyTelegramProfile(
  config: ServerConfig,
  installationId: string,
  patch: TelegramProfilePatch,
): Promise<{ applied: string[] }> {
  const token = await readPluginSecret(config, installationId, TELEGRAM_BOT_TOKEN_KEY);
  if (!token) throw new TelegramConnectError('no_token', 'Telegram is not connected');

  const applied: string[] = [];
  if (patch.name) {
    await setMyName(token, patch.name);
    applied.push('name');
  }
  if (patch.shortDescription !== undefined && patch.shortDescription !== null) {
    await setMyShortDescription(token, patch.shortDescription);
    applied.push('short_description');
  }
  if (patch.description !== undefined && patch.description !== null) {
    await setMyDescription(token, patch.description);
    applied.push('description');
  }
  if (patch.commands && patch.commands.length) {
    await setMyCommands(token, patch.commands);
    applied.push('commands');
  }

  const integration = await getIntegrationForInstallation(config, installationId);
  if (integration) {
    await updateIntegration(config, integration.id, {
      display_name: patch.name ?? integration.display_name,
      metadata: {
        ...(integration.metadata ?? {}),
        profile_synced_at: new Date().toISOString(),
        profile_synced_fields: applied,
      },
    });
  }

  return { applied };
}
