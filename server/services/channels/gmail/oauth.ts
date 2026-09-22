/**
 * GMAIL CHANNEL — OAuth consent flow + connection lifecycle.
 *
 * Mirrors `server/services/seo/gsc/index.ts`'s OAuth section closely (same
 * state-token CSRF pattern, same "Core calls Google directly" shape), but
 * plugs into the channel-plugin plumbing instead of a dedicated connections
 * table: `workspace_plugin_installations` (one per workspace+'gmail'),
 * `channel_integrations` (the connected mailbox — `external_account_id` is
 * the Gmail address), `plugin_secrets` (the encrypted refresh token, keyed
 * `gmail_refresh_token`). This is what lets Gmail show up in the same
 * Plugins marketplace and use the same installed/connected/disconnected
 * lifecycle as Telegram/WhatsApp/Instagram/X.
 *
 * Access tokens are never persisted — only the refresh token is stored. Each
 * call site (Core's watch-renewal ticker, the Worker's sync/outbound jobs)
 * mints/reuses its own short-lived in-memory access token.
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { randomToken } from '../../invitations/tokens.js';
import { isPluginCryptoConfigured } from '../../../lib/pluginCrypto.js';
import { storePluginSecret, readPluginSecret, deletePluginSecret, pluginCryptoReady } from '../../plugins/secrets.js';
import { getInstallation, installPlugin, setInstallationStatus } from '../../plugins/state.js';
import {
  createIntegration,
  getIntegrationForInstallation,
  updateIntegration,
  claimProviderAccount,
  releaseProviderAccount,
  DuplicateProviderAccountError,
  type ChannelIntegration,
} from '../../channels/integrations.js';
import { getGmailOAuthConfig } from './oauthConfig.js';
import { buildGmailAuthUrl, createGmailAdapter, type GmailAdapter } from '../../../../channels/mail/gmail/client.js';
import { GmailError, type GmailConnectionInfo } from './types.js';
import { GMAIL_PLUGIN_ID, GMAIL_REFRESH_TOKEN_KEY } from '../../../../shared/channels/gmailKeys.js';

export { GMAIL_PLUGIN_ID, GMAIL_REFRESH_TOKEN_KEY };
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

export function isGmailPlatformConfigured(): boolean {
  return getGmailOAuthConfig() !== null;
}

export function getGmailPubSubTopic(): string | null {
  return process.env.GMAIL_PUBSUB_TOPIC?.trim() || null;
}

function adapter(options?: Parameters<typeof createGmailAdapter>[1]): GmailAdapter {
  const cfg = getGmailOAuthConfig();
  if (!cfg) throw new GmailError('gmail_not_configured');
  return createGmailAdapter(cfg, options);
}

// ─── OAuth consent flow ─────────────────────────────────────────────────

export interface StartGmailOAuthResult {
  url: string;
}

export async function startGmailOAuth(
  config: ServerConfig,
  workspaceId: string,
  userId: string,
): Promise<StartGmailOAuthResult> {
  const cfg = getGmailOAuthConfig();
  if (!cfg) throw new GmailError('gmail_not_configured');
  if (!isPluginCryptoConfigured(config.pluginSecretsMasterKey)) throw new GmailError('gmail_not_configured');
  if (!getGmailPubSubTopic()) throw new GmailError('gmail_not_configured', undefined, 'GMAIL_PUBSUB_TOPIC is not set');

  const installation =
    (await getInstallation(config, workspaceId, GMAIL_PLUGIN_ID)) ??
    (await installPlugin(config, workspaceId, GMAIL_PLUGIN_ID, userId));
  if (installation.status !== 'installed') {
    await setInstallationStatus(config, installation.id, 'installed');
  }

  const token = randomToken(32);
  const sb = getServiceClient(config);
  const { error } = await sb.from('channel_oauth_states').insert({
    provider: 'gmail',
    token,
    workspace_id: workspaceId,
    installation_id: installation.id,
    initiated_by: userId,
    expires_at: new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString(),
  });
  if (error) throw new GmailError('gmail_provider_error');

  return { url: buildGmailAuthUrl(cfg, token) };
}

export interface GmailOAuthCallbackResult {
  workspaceId: string;
}

/** Handles Google's redirect back. Fails closed on any state mismatch/expiry/reuse. */
export async function handleGmailOAuthCallback(
  config: ServerConfig,
  code: string,
  state: string,
): Promise<GmailOAuthCallbackResult> {
  const sb = getServiceClient(config);
  const { data: stateRow, error: stateError } = await sb
    .from('channel_oauth_states')
    .select('token, workspace_id, installation_id, initiated_by, consumed_at, expires_at')
    .eq('token', state)
    .eq('provider', 'gmail')
    .maybeSingle();
  if (stateError || !stateRow) throw new GmailError('gmail_invalid_state');
  if (stateRow.consumed_at) throw new GmailError('gmail_invalid_state');
  if (new Date(stateRow.expires_at as string).getTime() < Date.now()) throw new GmailError('gmail_invalid_state');

  // Consume atomically-enough: mark used before doing anything else, so a
  // retried/duplicated callback can never replay the same code twice.
  const { error: consumeError, count } = await sb
    .from('channel_oauth_states')
    .update({ consumed_at: new Date().toISOString() }, { count: 'exact' })
    .eq('token', state)
    .is('consumed_at', null);
  if (consumeError || !count) throw new GmailError('gmail_invalid_state');

  const workspaceId = stateRow.workspace_id as string;
  const installationId = stateRow.installation_id as string;

  const ga = adapter();
  const tokens = await ga.exchangeCodeForTokens(code);
  if (!tokens.refreshToken) {
    throw new GmailError('gmail_auth_failed', undefined, 'Google granted no refresh token — reconnect');
  }
  // Google silently drops scopes the user unticked on the consent screen, so
  // verify Gmail access was actually granted BEFORE storing a connection
  // that would only fail later with a confusing 403.
  if (tokens.scope && !/auth\/gmail\.modify/.test(tokens.scope)) {
    throw new GmailError('gmail_insufficient_scope', undefined, `Granted scopes: ${tokens.scope}`);
  }
  if (tokens.scope && !/auth\/gmail\.send/.test(tokens.scope)) {
    throw new GmailError('gmail_insufficient_scope', undefined, `Granted scopes: ${tokens.scope}`);
  }
  const email = await ga.fetchAccountEmail(tokens.accessToken);
  if (!email) throw new GmailError('gmail_auth_failed', undefined, 'Could not resolve the connected Gmail address');

  let integration: ChannelIntegration =
    (await getIntegrationForInstallation(config, installationId)) ??
    (await createIntegration(config, { workspaceId, installationId, provider: 'gmail' }));

  try {
    await claimProviderAccount(config, integration, email);
  } catch (err) {
    if (err instanceof DuplicateProviderAccountError) {
      throw new GmailError('gmail_account_already_connected');
    }
    throw err;
  }

  await storePluginSecret(config, installationId, GMAIL_REFRESH_TOKEN_KEY, tokens.refreshToken);

  const topicName = getGmailPubSubTopic();
  let watchMetadata: Record<string, unknown> = {};
  if (topicName) {
    try {
      const watch = await ga.watchMailbox(tokens.accessToken, topicName);
      watchMetadata = { gmail_history_id: watch.historyId, gmail_watch_expiration: watch.expiration };
    } catch (err) {
      // Connection itself succeeded — a failed watch only means push
      // notifications won't arrive yet. gmailWatchRenewalTicker.ts retries
      // this on its own schedule, so surface the connection as connected
      // with an error note rather than rolling everything back.
      console.error(`[gmail] initial users.watch failed for workspace ${workspaceId}: ${err instanceof GmailError ? err.code : (err as Error)?.message}`);
    }
  }

  await updateIntegration(config, integration.id, {
    status: 'connected',
    external_account_id: email,
    display_name: email,
    username: email,
    webhook_registered_at: watchMetadata.gmail_history_id ? new Date().toISOString() : null,
    last_error_code: null,
    last_error_at: null,
    metadata: { ...integration.metadata, ...watchMetadata },
  });

  accessTokenCache.delete(installationId);
  return { workspaceId };
}

// ─── Connection status / disconnect ────────────────────────────────────

export async function getGmailConnectionInfo(config: ServerConfig, workspaceId: string): Promise<GmailConnectionInfo> {
  const installation = await getInstallation(config, workspaceId, GMAIL_PLUGIN_ID);
  if (!installation) return { connected: false, emailAddress: null, status: null, lastErrorCode: null, connectedAt: null };
  const integration = await getIntegrationForInstallation(config, installation.id);
  if (!integration) return { connected: false, emailAddress: null, status: null, lastErrorCode: null, connectedAt: null };
  return {
    connected: integration.status === 'connected',
    emailAddress: integration.external_account_id,
    status: integration.status,
    lastErrorCode: integration.last_error_code,
    connectedAt: integration.created_at ?? null,
  };
}

export async function disconnectGmail(config: ServerConfig, workspaceId: string): Promise<void> {
  const installation = await getInstallation(config, workspaceId, GMAIL_PLUGIN_ID);
  if (!installation) return;
  const integration = await getIntegrationForInstallation(config, installation.id);
  if (!integration) return;

  try {
    const refreshToken = await readPluginSecret(config, installation.id, GMAIL_REFRESH_TOKEN_KEY);
    if (refreshToken) {
      const ga = adapter();
      const tokens = await ga.refreshAccessToken(refreshToken).catch(() => null);
      if (tokens) await ga.stopWatch(tokens.accessToken);
      await ga.revokeToken(refreshToken);
    }
  } catch {
    // Best-effort revoke; the local rows are removed regardless below.
  }

  await deletePluginSecret(config, installation.id, GMAIL_REFRESH_TOKEN_KEY);
  await updateIntegration(config, integration.id, { status: 'disconnected' });
  await releaseProviderAccount(config, integration.id);
  await setInstallationStatus(config, installation.id, 'disabled');
  accessTokenCache.delete(installation.id);
}

// ─── Access-token cache (best-effort, in-process only) ─────────────────
//
// Shared shape with gsc/index.ts's cache, keyed by installation id (stable
// across a reconnect, unlike integration id which is recreated).

const accessTokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

/**
 * Resolves a live Gmail access token for an installation, refreshing and
 * caching as needed. Used by the Worker's job handlers and the watch-renewal
 * ticker — both resolve credentials by installation id, never handle a
 * client-supplied token.
 */
export async function getGmailAccessToken(config: ServerConfig, installationId: string): Promise<string> {
  const cached = accessTokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.accessToken;

  const refreshToken = await readPluginSecret(config, installationId, GMAIL_REFRESH_TOKEN_KEY);
  if (!refreshToken) throw new GmailError('gmail_not_connected');

  const ga = adapter();
  const tokens = await ga.refreshAccessToken(refreshToken);
  accessTokenCache.set(installationId, {
    accessToken: tokens.accessToken,
    expiresAt: Date.now() + tokens.expiresInSeconds * 1000,
  });
  return tokens.accessToken;
}

export { pluginCryptoReady };
