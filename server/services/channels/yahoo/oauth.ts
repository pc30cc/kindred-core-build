/**
 * YAHOO MAIL CHANNEL — OAuth consent flow + connection lifecycle.
 *
 * Mirrors server/services/channels/gmail/oauth.ts's shape closely (same
 * channel_oauth_states / channel_integrations / plugin_secrets plumbing),
 * with two differences: Yahoo has its own OAuth app (no shared platform
 * client to reuse), and there is no "watch" step — inbound delivery is a
 * self-rescheduling IMAP poll (worker/channels/index.ts's
 * `yahoo_poll_inbox` job), not a push subscription, so connecting just
 * means storing the refresh token and creating the integration row; the
 * Worker's poll job seeds its own first checkpoint.
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { randomToken } from '../../invitations/tokens.js';
import { isPluginCryptoConfigured } from '../../../lib/pluginCrypto.js';
import { storePluginSecret, readPluginSecret, deletePluginSecret } from '../../plugins/secrets.js';
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
import { getYahooOAuthConfig } from './oauthConfig.js';
import { buildYahooAuthUrl, createYahooAdapter, type YahooAdapter } from '../../../../channels/mail/yahoo/client.js';
import { YahooError, type YahooConnectionInfo } from './types.js';
import { seedPollLoop } from '../jobs.js';
import { YAHOO_PLUGIN_ID, YAHOO_REFRESH_TOKEN_KEY } from '../../../../shared/channels/yahooKeys.js';

export { YAHOO_PLUGIN_ID, YAHOO_REFRESH_TOKEN_KEY };
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

export function isYahooPlatformConfigured(): boolean {
  return getYahooOAuthConfig() !== null;
}

function adapter(options?: Parameters<typeof createYahooAdapter>[1]): YahooAdapter {
  const cfg = getYahooOAuthConfig();
  if (!cfg) throw new YahooError('yahoo_not_configured');
  return createYahooAdapter(cfg, options);
}

// ─── OAuth consent flow ─────────────────────────────────────────────────

export interface StartYahooOAuthResult {
  url: string;
}

export async function startYahooOAuth(
  config: ServerConfig,
  workspaceId: string,
  userId: string,
): Promise<StartYahooOAuthResult> {
  const cfg = getYahooOAuthConfig();
  if (!cfg) throw new YahooError('yahoo_not_configured');
  if (!isPluginCryptoConfigured(config.pluginSecretsMasterKey)) throw new YahooError('yahoo_not_configured');

  const installation =
    (await getInstallation(config, workspaceId, YAHOO_PLUGIN_ID)) ??
    (await installPlugin(config, workspaceId, YAHOO_PLUGIN_ID, userId));
  if (installation.status !== 'installed') {
    await setInstallationStatus(config, installation.id, 'installed');
  }

  const token = randomToken(32);
  const sb = getServiceClient(config);
  const { error } = await sb.from('channel_oauth_states').insert({
    provider: 'yahoo',
    token,
    workspace_id: workspaceId,
    installation_id: installation.id,
    initiated_by: userId,
    expires_at: new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString(),
  });
  if (error) throw new YahooError('yahoo_provider_error');

  return { url: buildYahooAuthUrl(cfg, token) };
}

export interface YahooOAuthCallbackResult {
  workspaceId: string;
}

export async function handleYahooOAuthCallback(
  config: ServerConfig,
  code: string,
  state: string,
): Promise<YahooOAuthCallbackResult> {
  const sb = getServiceClient(config);
  const { data: stateRow, error: stateError } = await sb
    .from('channel_oauth_states')
    .select('token, workspace_id, installation_id, initiated_by, consumed_at, expires_at')
    .eq('token', state)
    .eq('provider', 'yahoo')
    .maybeSingle();
  if (stateError || !stateRow) throw new YahooError('yahoo_invalid_state');
  if (stateRow.consumed_at) throw new YahooError('yahoo_invalid_state');
  if (new Date(stateRow.expires_at as string).getTime() < Date.now()) throw new YahooError('yahoo_invalid_state');

  const { error: consumeError, count } = await sb
    .from('channel_oauth_states')
    .update({ consumed_at: new Date().toISOString() }, { count: 'exact' })
    .eq('token', state)
    .is('consumed_at', null);
  if (consumeError || !count) throw new YahooError('yahoo_invalid_state');

  const workspaceId = stateRow.workspace_id as string;
  const installationId = stateRow.installation_id as string;

  const ya = adapter();
  const tokens = await ya.exchangeCodeForTokens(code);
  if (!tokens.refreshToken) {
    throw new YahooError('yahoo_auth_failed', undefined, 'Yahoo granted no refresh token — reconnect');
  }
  const email = await ya.fetchAccountEmail(tokens.accessToken);
  if (!email) throw new YahooError('yahoo_auth_failed', undefined, 'Could not resolve the connected Yahoo Mail address');

  const integration: ChannelIntegration =
    (await getIntegrationForInstallation(config, installationId)) ??
    (await createIntegration(config, { workspaceId, installationId, provider: 'yahoo' }));

  try {
    await claimProviderAccount(config, integration, email);
  } catch (err) {
    if (err instanceof DuplicateProviderAccountError) throw new YahooError('yahoo_account_already_connected');
    throw err;
  }

  await storePluginSecret(config, installationId, YAHOO_REFRESH_TOKEN_KEY, tokens.refreshToken);

  await updateIntegration(config, integration.id, {
    status: 'connected',
    external_account_id: email,
    display_name: email,
    username: email,
    last_error_code: null,
    last_error_at: null,
  });

  accessTokenCache.delete(installationId);

  // Seed the first poll immediately rather than waiting a full interval —
  // the job carries no checkpoint yet, so it fetches the most recent
  // messages and establishes the UID watermark for every poll after. A
  // reconnect replaces the loop rather than starting a second one beside it
  // (which kept polling the previous address forever).
  await seedPollLoop(sb, {
    provider: 'yahoo',
    jobType: 'yahoo_poll_inbox',
    workspaceId,
    integrationId: integration.id,
    payload: { email_address: email, since_uid: null },
  });

  return { workspaceId };
}

// ─── Connection status / disconnect ────────────────────────────────────

export async function getYahooConnectionInfo(config: ServerConfig, workspaceId: string): Promise<YahooConnectionInfo> {
  const installation = await getInstallation(config, workspaceId, YAHOO_PLUGIN_ID);
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

export async function disconnectYahoo(config: ServerConfig, workspaceId: string): Promise<void> {
  const installation = await getInstallation(config, workspaceId, YAHOO_PLUGIN_ID);
  if (!installation) return;
  const integration = await getIntegrationForInstallation(config, installation.id);
  if (!integration) return;

  await deletePluginSecret(config, installation.id, YAHOO_REFRESH_TOKEN_KEY);
  await updateIntegration(config, integration.id, { status: 'disconnected' });
  await releaseProviderAccount(config, integration.id);
  await setInstallationStatus(config, installation.id, 'disabled');
  accessTokenCache.delete(installation.id);
}

// ─── Access-token cache (best-effort, in-process only) ─────────────────

const accessTokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

export async function getYahooAccessToken(config: ServerConfig, installationId: string): Promise<string> {
  const cached = accessTokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.accessToken;

  const refreshToken = await readPluginSecret(config, installationId, YAHOO_REFRESH_TOKEN_KEY);
  if (!refreshToken) throw new YahooError('yahoo_not_connected');

  const ya = adapter();
  const tokens = await ya.refreshAccessToken(refreshToken);
  accessTokenCache.set(installationId, {
    accessToken: tokens.accessToken,
    expiresAt: Date.now() + tokens.expiresInSeconds * 1000,
  });
  // Yahoo does not always re-issue a refresh token — only overwrite the
  // stored one when a new one actually came back.
  if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
    await storePluginSecret(config, installationId, YAHOO_REFRESH_TOKEN_KEY, tokens.refreshToken);
  }
  return tokens.accessToken;
}
