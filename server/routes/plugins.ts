/**
 * Plugin Platform API.
 *
 * Two surfaces, both authorization-gated before any service-role query:
 *   - /api/plugins/*        workspace operators (JWT + workspace membership)
 *   - /api/plugins/admin/*  platform Super Admin only
 *
 * Credentials are write-only: a bot token can be submitted but never read
 * back. Every response returns `hasToken` instead of the value.
 */

import { Router } from 'express';
import { z } from 'zod';
import { authorizeWorkspaceAccess, requirePlatformAdmin, serverConfigOf } from '../lib/workspaceAuth.js';
import { redactSecrets } from '../lib/redactSecrets.js';
import { checkChannelAccess, checkModuleAccess } from '../middleware/featureGating.js';
import { PLUGIN_REGISTRY, getPluginDefinition } from '../plugins/registry.js';
import {
  getInstallation,
  getPlatformState,
  installPlugin,
  listInstallations,
  listPlatformState,
  setInstallationStatus,
  toCatalogEntry,
  updateInstallationSettings,
  updatePlatformState,
} from '../services/plugins/state.js';
import {
  deletePluginSecret,
  hasPluginSecret,
  pluginCryptoReady,
} from '../services/plugins/secrets.js';
import { botProvider, isBotProvider } from '../../shared/channels/botProviders.js';

import {
  buildWebhookUrl,
  createIntegration,
  getIntegrationById,
  getIntegrationForInstallation,
} from '../services/channels/integrations.js';
import {
  TelegramConnectError,
  connectResultOf,
  requestTelegramConnect,
  requestTelegramDiagnostics,
  requestTelegramDisconnect,
  requestTelegramProfileSync,
  requestTelegramWebhookRepair,
  telegramDiagnosticsView,
} from '../services/channels/telegram/setup.js';
import { InFlightOperationError, awaitOperation } from '../services/channels/operations.js';
import { parseTelegramSettings, sanitizeTelegramSettingsForSave, resolveTelegramHandlingMode, buildTelegramCommandList } from '../services/channels/telegram/settings.js';
import { resolveTelegramReplyLocale } from '../services/channels/telegram/runtime.js';

import { isAutoAnswerAllowedForWorkspace } from '../services/ai-agent/platformGuards.js';
import { getOrCreateSettings } from '../services/ai-agent/settings.js';

import { getServiceClient } from '../supabase.js';
import { queueMetrics } from '../services/channels/jobs.js';

export const pluginsRouter = Router();

const MANAGE_ROLES = ['owner', 'admin'];

/** Workspace guard: real JWT + membership + manage-level role. */
async function requireManager(req: any, res: any, workspaceId: string) {
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return null;
  if (!auth.isAdmin && !MANAGE_ROLES.includes(auth.role ?? '')) {
    res.status(403).json({ error: 'Insufficient workspace role' });
    return null;
  }
  return auth;
}

/**
 * Plan gate for a plugin.
 *
 * Channel plugins (Telegram, and the upcoming WhatsApp/SMS/Instagram) are sold
 * as plan CHANNELS, so they must be checked with `check_channel_access` — the
 * same key the Super Admin Plans screen toggles. Only non-channel plugins fall
 * back to a module entitlement.
 */
async function isPluginAllowedByPlan(
  config: ReturnType<typeof serverConfigOf>,
  def: { planChannelKey: string | null; planModuleKey: string | null },
  workspaceId: string,
): Promise<boolean> {
  if (def.planChannelKey) {
    const entitlement = await checkChannelAccess(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      workspaceId,
      def.planChannelKey,
    );
    return entitlement.allowed === true;
  }
  if (def.planModuleKey) {
    const entitlement = await checkModuleAccess(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      workspaceId,
      def.planModuleKey,
    );
    return entitlement.allowed === true;
  }
  return true;
}

/** A plugin is usable only when platform state AND the plan both allow it. */
async function resolveAvailability(req: any, workspaceId: string, pluginId: string) {
  const config = serverConfigOf(req);
  const def = getPluginDefinition(pluginId);
  if (!def) return { ok: false as const, reason: 'unknown_plugin' };

  const state = await getPlatformState(config, pluginId);
  if (!state.enabled) return { ok: false as const, reason: 'disabled_by_platform' };
  if (state.maintenance_mode) return { ok: false as const, reason: 'maintenance_mode' };
  if (!state.installable || !def.workspaceInstallable) return { ok: false as const, reason: 'not_installable' };

  const planAllowed = await isPluginAllowedByPlan(config, def, workspaceId);
  if (!planAllowed) return { ok: false as const, reason: 'plan_locked' };
  return { ok: true as const, def, state };
}

// ── Catalog ───────────────────────────────────────────────────────────

pluginsRouter.get('/catalog', async (req: any, res) => {
  const workspaceId = String(req.query.workspace_id || '');
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;

  try {
    const config = serverConfigOf(req);
    const [states, installations] = await Promise.all([
      listPlatformState(config),
      listInstallations(config, workspaceId),
    ]);
    const stateById = new Map(states.map((s) => [s.plugin_id, s]));
    const installedById = new Map(installations.map((i) => [i.plugin_id, i]));

    const items = await Promise.all(
      PLUGIN_REGISTRY.filter((def) => {
        const state = stateById.get(def.id)!;
        return state.marketplace_visible && state.rollout_status !== 'hidden';
      }).map(async (def) => {
        const state = stateById.get(def.id)!;
        const entry = toCatalogEntry(def, state);
        const planAllowed = await isPluginAllowedByPlan(config, def, workspaceId);
        const installation = installedById.get(def.id) ?? null;
        return {
          ...entry,
          planAllowed,
          installed: !!installation && installation.status !== 'uninstalled',
          installationStatus: installation?.status ?? null,
          installationId: installation?.id ?? null,
        };
      }),
    );

    items.sort((a, b) => Number(b.featured) - Number(a.featured) || a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
    res.json({ items });
  } catch (err) {
    console.error('[plugins] catalog failed:', err);
    res.status(500).json({ error: 'Failed to load plugin catalog' });
  }
});

// ── Install / uninstall ───────────────────────────────────────────────

const installSchema = z.object({
  workspace_id: z.string().uuid(),
  plugin_id: z.string().min(1).max(64),
});

pluginsRouter.post('/install', async (req: any, res) => {
  const parsed = installSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
  const { workspace_id: workspaceId, plugin_id: pluginId } = parsed.data;

  const auth = await requireManager(req, res, workspaceId);
  if (!auth) return;

  try {
    const availability = await resolveAvailability(req, workspaceId, pluginId);
    if (!availability.ok) return res.status(403).json({ error: 'Plugin unavailable', reason: availability.reason });

    const config = serverConfigOf(req);
    const installation = await installPlugin(config, workspaceId, pluginId, auth.userId);
    res.json({ installation: { id: installation.id, pluginId, status: installation.status } });
  } catch (err) {
    console.error('[plugins] install failed:', err);
    res.status(500).json({ error: 'Failed to install plugin' });
  }
});

pluginsRouter.post('/uninstall', async (req: any, res) => {
  const parsed = installSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
  const { workspace_id: workspaceId, plugin_id: pluginId } = parsed.data;

  const auth = await requireManager(req, res, workspaceId);
  if (!auth) return;

  try {
    const config = serverConfigOf(req);
    const installation = await getInstallation(config, workspaceId, pluginId);
    if (!installation) return res.json({ ok: true });

    // Provider-side cleanup first so no orphan webhook keeps delivering.
    if (isBotProvider(pluginId)) {
      await requestTelegramDisconnect(config, installation.id, auth.userId);
      await deletePluginSecret(config, installation.id, botProvider(pluginId).secretKeys.live);
    }
    await setInstallationStatus(config, installation.id, 'uninstalled');
    res.json({ ok: true });
  } catch (err) {
    console.error('[plugins] uninstall failed:', err);
    res.status(500).json({ error: 'Failed to uninstall plugin' });
  }
});

// ── Bot channel configuration (Telegram, Bale) ────────────────────────
//
// Telegram and Bale share ONE implementation: Bale speaks the Telegram Bot
// API on its own host. The historical `/telegram/*` paths keep working and
// every provider is also reachable at `/bot/:provider/*`.

/** Resolves and validates the bot provider addressed by the request. */
function botProviderOf(req: any, res: any): string | null {
  const provider = String(req.params?.provider || 'telegram');
  if (!isBotProvider(provider)) {
    res.status(404).json({ error: 'unknown_provider' });
    return null;
  }
  return provider;
}

const botPaths = (suffix: string) => [`/telegram/${suffix}`, `/bot/:provider/${suffix}`];


const telegramConnectSchema = z.object({
  workspace_id: z.string().uuid(),
  bot_token: z.string().min(20).max(200).regex(/^\d{6,}:[A-Za-z0-9_-]{20,}$/, 'Invalid bot token format'),
});

/**
 * WhatsApp Cloud is not a bot-token provider: a connection is a phone number
 * id plus a permanent access token (optionally the WABA id). Both are stored
 * in the SAME encrypted credential slot as a JSON envelope, so the whole
 * credential lifecycle (stage → promote → destroy) stays provider-neutral.
 */
const whatsappConnectSchema = z.object({
  workspace_id: z.string().uuid(),
  phone_number_id: z.string().min(5).max(64).regex(/^\d+$/, 'Invalid phone number id'),
  access_token: z.string().min(20).max(512),
  business_account_id: z.string().max(64).optional().nullable(),
});

/** Normalizes a connect body into the credential string for `provider`. */
function parseConnectCredential(
  provider: string,
  body: unknown,
): { workspaceId: string; credential: string } | null {
  if (botProvider(provider).credentialKind === 'whatsapp_cloud') {
    const parsed = whatsappConnectSchema.safeParse(body);
    if (!parsed.success) return null;
    return {
      workspaceId: parsed.data.workspace_id,
      credential: JSON.stringify({
        phone_number_id: parsed.data.phone_number_id,
        access_token: parsed.data.access_token,
        business_account_id: parsed.data.business_account_id || null,
      }),
    };
  }
  const parsed = telegramConnectSchema.safeParse(body);
  if (!parsed.success) return null;
  return { workspaceId: parsed.data.workspace_id, credential: parsed.data.bot_token };
}

pluginsRouter.post(botPaths('connect'), async (req: any, res) => {
  const provider = botProviderOf(req, res);
  if (!provider) return;
  const parsed = parseConnectCredential(provider, req.body);
  if (!parsed) return res.status(400).json({ error: 'Invalid credentials' });
  const { workspaceId, credential: botToken } = parsed;

  const auth = await requireManager(req, res, workspaceId);
  if (!auth) return;

  try {
    const config = serverConfigOf(req);
    if (!pluginCryptoReady(config)) {
      return res.status(503).json({
        error: 'telegram_connect_failed',
        reason: 'encryption_not_configured',
        details: 'PLUGIN_SECRETS_MASTER_KEY is not set on this server',
      });
    }
    const missingChannelEnv = [
      config.channelsWebhookSigningKey ? null : 'CHANNELS_WEBHOOK_SIGNING_KEY',
      config.publicChannelsBaseUrl ? null : 'PUBLIC_CHANNELS_BASE_URL',
    ].filter(Boolean);
    if (missingChannelEnv.length) {
      return res.status(503).json({
        error: 'telegram_connect_failed',
        reason: 'channels_not_configured',
        details: `Missing server configuration: ${missingChannelEnv.join(', ')}`,
      });
    }


    const availability = await resolveAvailability(req, workspaceId, provider);
    if (!availability.ok) return res.status(403).json({ error: 'Plugin unavailable', reason: availability.reason });

    const installation =
      (await getInstallation(config, workspaceId, provider)) ??
      (await installPlugin(config, workspaceId, provider, auth.userId));
    if (installation.status !== 'installed') {
      await setInstallationStatus(config, installation.id, 'installed');
    }

    const integration =
      (await getIntegrationForInstallation(config, installation.id)) ??
      (await createIntegration(config, {
        workspaceId,
        installationId: installation.id,
        provider,
      }));

    // Core cannot reach Telegram: the handshake is executed by the Channels
    // Worker. We wait a bounded time so the UI stays synchronous when the
    // worker is healthy, and reports "in progress" when it is not.
    const operation = await requestTelegramConnect(config, integration, botToken, auth.userId);
    const settled = await awaitOperation(config, operation.id);

    if (settled?.status === 'failed') {
      const reason = settled.error_code || 'telegram_connect_failed';
      const status = reason === 'duplicate_bot' ? 409 : reason === 'not_configured' ? 503 : 502;
      return res.status(status).json({
        error: 'telegram_connect_failed',
        reason,
        details: settled.error_message || reason,
        operationId: operation.id,
      });
    }

    const result = settled ? connectResultOf(settled) : null;
    if (!result) {
      // Queued and verifiable, but the worker has not answered yet. Never
      // claim a connection that the provider has not confirmed.
      return res.status(202).json({
        ok: false,
        pending: true,
        operationId: operation.id,
        reason: 'worker_pending',
      });
    }

    res.json({
      ok: true,
      hasToken: true,
      bot: result.bot,
      verifiedAt: result.verifiedAt,
      webhookUrl: result.webhookUrl,
      operationId: operation.id,
    });
  } catch (err) {
    if (err instanceof InFlightOperationError) {
      return res
        .status(409)
        .json({ error: 'telegram_connect_failed', reason: 'operation_in_flight', details: err.message });
    }
    if (err instanceof TelegramConnectError) {
      const status = err.code === 'duplicate_bot' ? 409 : err.code === 'not_configured' ? 503 : 502;
      console.error(`[plugins] telegram connect failed: ${err.code}: ${err.message}`);
      // `message` is already token-redacted by the setup service.
      return res
        .status(status)
        .json({ error: 'telegram_connect_failed', reason: err.code, details: err.message });
    }
    const message = redactSecrets(err instanceof Error ? err.message : 'unknown error') ?? 'unknown error';
    console.error('[plugins] telegram connect failed:', message);
    res
      .status(502)
      .json({ error: 'telegram_connect_failed', reason: 'unexpected_error', details: message });
  }

});

pluginsRouter.get(botPaths('status'), async (req: any, res) => {
  const provider = botProviderOf(req, res);
  if (!provider) return;
  const workspaceId = String(req.query.workspace_id || '');
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
  const auth = await requireManager(req, res, workspaceId);
  if (!auth) return;

  try {
    const config = serverConfigOf(req);
    const installation = await getInstallation(config, workspaceId, provider);
    if (!installation || installation.status === 'uninstalled') {
      return res.json({ installed: false });
    }
    const integration = await getIntegrationForInstallation(config, installation.id);
    const telegramSettings = parseTelegramSettings(installation.settings);
    const { aiAvailable } = await resolveTelegramHandlingMode(config, workspaceId, telegramSettings.handlingMode, provider);
    // Why an "enabled" AI can still stay silent: the assistant is gated by the
    // platform kill switch and by the workspace AI Agent mode, independently of
    // the Telegram handling mode. Surface both so the operator sees the cause.
    const aiAgentDiagnostics = await (async () => {
      try {
        const [platformGate, agentSettings] = await Promise.all([
          isAutoAnswerAllowedForWorkspace(config, workspaceId),
          getOrCreateSettings(config, workspaceId),
        ]);
        return {
          platformAllowed: platformGate.allowed === true,
          platformReason: platformGate.allowed === true ? null : (platformGate as any).reason,
          agentEnabled: !!(agentSettings as any)?.enabled && (agentSettings as any)?.mode !== 'off',
          agentMode: (agentSettings as any)?.mode ?? null,
        };
      } catch {
        return null;
      }
    })();
    res.json({
      installed: true,
      status: installation.status,
      // Merged with defaults so the UI never has to guess at missing keys.
      // `bot_token` never lives in this object — it is stored separately,
      // encrypted, and never read back (see `hasToken` below).
      settings: telegramSettings,
      aiAvailable,
      aiAgent: aiAgentDiagnostics,
      hasToken: await hasPluginSecret(config, installation.id, botProvider(provider).secretKeys.live),

      integration: integration
        ? {
            status: integration.status,
            botUsername: integration.username,
            botName: integration.display_name,
            webhookRegisteredAt: integration.webhook_registered_at,
            webhookVerifiedAt: integration.webhook_verified_at,
            lastInboundAt: integration.last_inbound_at,
            lastOutboundAt: integration.last_outbound_at,
            lastErrorCode: integration.last_error_code,
            lastErrorAt: integration.last_error_at,
            webhookUrl: config.publicChannelsBaseUrl
              ? buildWebhookUrl(config, provider, integration.public_integration_id)
              : null,
            // Providers whose callback URL is registered in their OWN
            // dashboard (WhatsApp Cloud) need the verify token shown once so
            // the operator can paste it into the Meta app configuration.
            verifyToken:
              !botProvider(provider).supportsWebhookRegistration && config.channelsWebhookSigningKey
                ? deriveChannelWebhookSecret(
                    config.channelsWebhookSigningKey,
                    provider,
                    integration.public_integration_id,
                  )
                : null,
            managesWebhookExternally: !botProvider(provider).supportsWebhookRegistration,
          }
        : null,
    });
  } catch (err) {
    console.error('[plugins] telegram status failed:', err);
    res.status(500).json({ error: 'Failed to load Telegram status' });
  }
});

/**
 * Provider operations are executed by the Channels Worker. When no worker has
 * reported a heartbeat recently, the operation would sit pending until the
 * route's await deadline and the reverse proxy would answer 502 with no
 * explanation. Detect it up front and say so.
 */
async function channelsWorkerOffline(req: any): Promise<boolean> {
  try {
    const sb = getServiceClient(serverConfigOf(req));
    const staleBefore = new Date(Date.now() - 120_000).toISOString();
    const { data } = await sb
      .from('channel_worker_heartbeats')
      .select('worker_id,last_seen_at')
      .gte('last_seen_at', staleBefore)
      .limit(1);
    return !(data && data.length > 0);
  } catch {
    // Never block the action on the liveness probe itself.
    return false;
  }
}

pluginsRouter.post(botPaths('diagnostics'), async (req: any, res) => {
  const provider = botProviderOf(req, res);
  if (!provider) return;

  const workspaceId = String(req.body?.workspace_id || '');
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
  const auth = await requireManager(req, res, workspaceId);
  if (!auth) return;

  try {
    const config = serverConfigOf(req);
    const installation = await getInstallation(config, workspaceId, provider);
    if (!installation) return res.status(404).json({ error: 'Telegram is not installed' });
    if (await channelsWorkerOffline(req)) {
      return res
        .status(503)
        .json({ error: 'worker_offline', reason: 'channels_worker_offline' });
    }

    // Provider probe runs in the worker; Core only compares what comes back.
    let operation = null as Awaited<ReturnType<typeof requestTelegramDiagnostics>> | null;
    try {
      operation = await awaitOperation(config, (await requestTelegramDiagnostics(config, installation.id)).id, 12_000);
    } catch (probeErr) {
      if (!(probeErr instanceof InFlightOperationError)) throw probeErr;
    }
    res.json(await telegramDiagnosticsView(config, installation.id, operation));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    console.error('[plugins] telegram diagnostics failed:', message);
    res.status(502).json({ error: 'Diagnostics failed', details: message });
  }
});

/**
 * Reconnect / repair: re-registers the webhook with the SAME stored
 * credential. Used when diagnostics report drift (wrong URL, provider-side
 * reset) without asking the operator to paste the token again.
 */
pluginsRouter.post(botPaths('reconnect'), async (req: any, res) => {
  const provider = botProviderOf(req, res);
  if (!provider) return;
  const workspaceId = String(req.body?.workspace_id || '');
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
  const auth = await requireManager(req, res, workspaceId);
  if (!auth) return;

  try {
    const config = serverConfigOf(req);
    const installation = await getInstallation(config, workspaceId, provider);
    if (!installation) return res.status(404).json({ error: 'not_installed' });
    if (await channelsWorkerOffline(req)) {
      return res
        .status(503)
        .json({ error: 'repair_failed', reason: 'channels_worker_offline' });
    }


    const operation = await requestTelegramWebhookRepair(config, installation.id, auth.userId);
    const settled = await awaitOperation(config, operation.id, 15_000);
    if (!settled || settled.status === 'pending' || settled.status === 'running') {
      return res.status(202).json({ ok: false, pending: true, operationId: operation.id });
    }
    if (settled.status === 'failed') {
      return res
        .status(502)
        .json({ error: 'repair_failed', reason: settled.error_code || 'repair_failed', operationId: operation.id });
    }
    res.json({ ok: true, operationId: operation.id });
  } catch (err) {
    console.error('[plugins] telegram reconnect failed:', err);
    res.status(502).json({ error: 'repair_failed', reason: 'unexpected_error' });
  }
});

/**
 * Disconnect: removes the provider webhook and the stored credential but
 * KEEPS the installation and all conversation history.
 */
pluginsRouter.post(botPaths('disconnect'), async (req: any, res) => {
  const provider = botProviderOf(req, res);
  if (!provider) return;
  const workspaceId = String(req.body?.workspace_id || '');
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
  const auth = await requireManager(req, res, workspaceId);
  if (!auth) return;

  try {
    const config = serverConfigOf(req);
    const installation = await getInstallation(config, workspaceId, provider);
    if (!installation) return res.json({ ok: true });

    // Local acceptance stops immediately; the provider webhook is removed by
    // the worker, which then triggers credential destruction in Core.
    const { operation } = await requestTelegramDisconnect(config, installation.id, auth.userId);
    res.json({ ok: true, operationId: operation?.id ?? null });
  } catch (err) {
    console.error('[plugins] telegram disconnect failed:', err);
    res.status(502).json({ error: 'disconnect_failed' });
  }
});

/** Bot branding: name, descriptions and the /command menu. */
const telegramProfileSchema = z.object({
  workspace_id: z.string().uuid(),
  name: z.string().min(1).max(64).optional(),
  short_description: z.string().max(120).optional(),
  description: z.string().max(512).optional(),
  commands: z
    .array(z.object({ command: z.string().min(1).max(32), description: z.string().min(1).max(256) }))
    .max(100)
    .optional(),
});

pluginsRouter.post(botPaths('profile'), async (req: any, res) => {
  const provider = botProviderOf(req, res);
  if (!provider) return;
  const parsed = telegramProfileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_profile' });
  const auth = await requireManager(req, res, parsed.data.workspace_id);
  if (!auth) return;

  try {
    const config = serverConfigOf(req);
    const installation = await getInstallation(config, parsed.data.workspace_id, provider);
    if (!installation) return res.status(404).json({ error: 'not_installed' });

    const operation = await requestTelegramProfileSync(config, installation.id, {
      name: parsed.data.name,
      shortDescription: parsed.data.short_description,
      description: parsed.data.description,
      commands: parsed.data.commands?.map((c) => ({
        command: String(c.command),
        description: String(c.description),
      })),
    }, auth.userId);
    const settled = await awaitOperation(config, operation.id, 15_000);
    if (settled?.status === 'failed') {
      return res
        .status(502)
        .json({ error: 'profile_update_failed', reason: settled.error_code, operationId: operation.id });
    }
    if (settled?.status !== 'succeeded') {
      return res.status(202).json({ ok: false, pending: true, operationId: operation.id });
    }
    res.json({ ok: true, applied: (settled.result as any)?.applied ?? [], operationId: operation.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    console.error('[plugins] telegram profile failed:', message);
    res.status(502).json({ error: 'profile_update_failed' });
  }
});

const settingsSchema = z.object({
  workspace_id: z.string().uuid(),
  plugin_id: z.string().min(1).max(64),
  settings: z.record(z.unknown()),
});

pluginsRouter.put('/settings', async (req: any, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
  const { workspace_id: workspaceId, plugin_id: pluginId, settings } = parsed.data;

  const auth = await requireManager(req, res, workspaceId);
  if (!auth) return;

  try {
    const config = serverConfigOf(req);
    const installation = await getInstallation(config, workspaceId, pluginId);
    if (!installation) return res.status(404).json({ error: 'Plugin is not installed' });
    // Settings never carry credentials.
    delete (settings as any).bot_token;

    let toPersist: Record<string, unknown> = settings;
    if (isBotProvider(pluginId)) {
      // Deep-merge onto the existing (already-defaulted) settings so a
      // partial save (e.g. only the `fa` locale) never wipes other locales,
      // and downgrade ai_first → human_only when the AI entitlement is gone.
      const merged = parseTelegramSettings({ ...parseTelegramSettings(installation.settings), ...settings });
      toPersist = await sanitizeTelegramSettingsForSave(config, workspaceId, merged, pluginId);
    }

    await updateInstallationSettings(config, installation.id, toPersist);

    // Telegram's NATIVE command list (the "Menu" button next to the input)
    // lives on the provider, not in our settings row. Re-sync it on every
    // save so retired/disabled entries disappear from the client instead of
    // lingering until someone opens the branding form.
    if (isBotProvider(pluginId)) {
      void (async () => {
        try {
          const parsedSettings = parseTelegramSettings(toPersist);
          const { fallbackLocale } = await resolveTelegramReplyLocale(config, null);
          await requestTelegramProfileSync(config, installation.id, {
            commands: buildTelegramCommandList(parsedSettings, fallbackLocale),
          }, auth.userId);
        } catch (syncErr) {
          console.warn(
            '[plugins] telegram command sync skipped:',
            syncErr instanceof Error ? syncErr.message : syncErr,
          );
        }
      })();
    }

    res.json({ ok: true, settings: isBotProvider(pluginId) ? toPersist : undefined });

  } catch (err) {
    console.error('[plugins] settings update failed:', err);
    res.status(500).json({ error: 'Failed to update plugin settings' });
  }
});

// ── Activity log (workspace surface) ──────────────────────────────────

/** Shapes a job row into a provider-neutral, credential-free log entry. */
function jobLogEntry(row: any) {
  return {
    id: row.id,
    kind: 'job' as const,
    provider: row.provider,
    type: row.job_type,
    status: row.status,
    attempts: row.attempt_count,
    error: row.last_error ? redactSecrets(String(row.last_error)).slice(0, 500) : null,
    workspaceId: row.workspace_id ?? null,
    at: row.updated_at ?? row.created_at,
  };
}

/** Inbound events never expose the raw provider payload (PII + tokens). */
function inboundLogEntry(row: any) {
  return {
    id: row.id,
    kind: 'inbound' as const,
    provider: row.provider,
    type: 'inbound_event',
    status: row.status,
    attempts: null as number | null,
    error: row.last_error ? redactSecrets(String(row.last_error)).slice(0, 500) : null,
    workspaceId: row.workspace_id ?? null,
    at: row.processed_at ?? row.created_at,
  };
}

/**
 * Recent channel activity for ONE workspace + plugin. Read-only and
 * deliberately payload-free: operators need status and failure reasons, not
 * message contents, on an observability screen.
 */
pluginsRouter.get('/logs', async (req: any, res) => {
  const workspaceId = String(req.query.workspace_id || '');
  const pluginId = String(req.query.plugin_id || '');
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId) || !getPluginDefinition(pluginId)) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const auth = await requireManager(req, res, workspaceId);
  if (!auth) return;

  try {
    const sb = getServiceClient(serverConfigOf(req));
    const [jobs, inbound] = await Promise.all([
      sb
        .from('channel_jobs')
        .select('id,provider,job_type,status,attempt_count,last_error,created_at,updated_at,workspace_id')
        .eq('workspace_id', workspaceId)
        .eq('provider', pluginId)
        .order('updated_at', { ascending: false })
        .limit(60),
      sb
        .from('channel_inbound_events')
        .select('id,provider,status,last_error,created_at,processed_at,workspace_id')
        .eq('workspace_id', workspaceId)
        .eq('provider', pluginId)
        .order('created_at', { ascending: false })
        .limit(60),
    ]);
    if (jobs.error) throw new Error(jobs.error.message);
    if (inbound.error) throw new Error(inbound.error.message);

    const items = [...(jobs.data ?? []).map(jobLogEntry), ...(inbound.data ?? []).map(inboundLogEntry)]
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 100);
    res.json({ items });
  } catch (err) {
    console.error('[plugins] workspace logs failed:', err);
    res.status(500).json({ error: 'Failed to load plugin logs' });
  }
});

// ── Super Admin surface ───────────────────────────────────────────────


export const adminPluginsRouter = Router();

adminPluginsRouter.use(async (req: any, res, next) => {
  const adminId = await requirePlatformAdmin(req, res);
  if (!adminId) return;
  req.platformAdminId = adminId;
  next();
});

adminPluginsRouter.get('/', async (req: any, res) => {
  try {
    const states = await listPlatformState(serverConfigOf(req));
    const stateById = new Map(states.map((s) => [s.plugin_id, s]));
    res.json({
      items: PLUGIN_REGISTRY.map((def) => ({
        ...toCatalogEntry(def, stateById.get(def.id)!),
        policy: stateById.get(def.id)!.policy,
      })),
    });
  } catch (err) {
    console.error('[plugins] admin list failed:', err);
    res.status(500).json({ error: 'Failed to load plugins' });
  }
});

const adminStateSchema = z.object({
  enabled: z.boolean().optional(),
  marketplace_visible: z.boolean().optional(),
  installable: z.boolean().optional(),
  maintenance_mode: z.boolean().optional(),
  featured: z.boolean().optional(),
  sort_order: z.number().int().min(0).max(9999).optional(),
  rollout_status: z.enum(['hidden', 'coming_soon', 'beta', 'public']).optional(),
  policy: z.record(z.unknown()).optional(),
});

adminPluginsRouter.patch('/:pluginId', async (req: any, res) => {
  const pluginId = String(req.params.pluginId);
  if (!getPluginDefinition(pluginId)) return res.status(404).json({ error: 'Unknown plugin' });

  const parsed = adminStateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });

  try {
    const state = await updatePlatformState(serverConfigOf(req), pluginId, parsed.data as any, req.platformAdminId);
    res.json({ state });
  } catch (err) {
    console.error('[plugins] admin update failed:', err);
    res.status(500).json({ error: 'Failed to update plugin state' });
  }
});


// ── Super Admin: runtime observability & intervention ─────────────────

/**
 * Every channel integration across all workspaces, with the operational
 * fields the runtime panel needs. Credentials are never included.
 */
adminPluginsRouter.get('/channels/integrations', async (req: any, res) => {
  try {
    const sb = getServiceClient(serverConfigOf(req));
    const { data, error } = await sb
      .from('channel_integrations')
      .select(
        'id,workspace_id,installation_id,provider,status,username,display_name,external_account_id,' +
          'webhook_registered_at,webhook_verified_at,last_inbound_at,last_outbound_at,last_error_code,last_error_at,created_at',
      )
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    res.json({ items: data ?? [] });
  } catch (err) {
    console.error('[plugins] admin integrations failed:', err);
    res.status(500).json({ error: 'Failed to load integrations' });
  }
});

/** Queue depth, lag, dead-letter count and worker liveness. */
adminPluginsRouter.get('/channels/health', async (req: any, res) => {
  try {
    const sb = getServiceClient(serverConfigOf(req));
    const staleBefore = new Date(Date.now() - 60_000).toISOString();

    const [metrics, heartbeats, failures] = await Promise.all([
      queueMetrics(sb),
      sb
        .from('channel_worker_heartbeats')
        .select('worker_id,worker_kind,last_seen_at,code_version')
        .order('last_seen_at', { ascending: false })
        .limit(50),
      sb
        .from('channel_jobs')
        .select('id,provider,job_type,attempt_count,last_error,updated_at')
        .eq('status', 'failed')
        .order('updated_at', { ascending: false })
        .limit(20),
    ]);

    const workers = (heartbeats.data ?? []).map((w: any) => ({
      ...w,
      alive: w.last_seen_at > staleBefore,
    }));

    res.json({
      queue: metrics,
      workers,
      workersAlive: workers.filter((w: any) => w.alive).length,
      deadLetters: failures.data ?? [],
    });
  } catch (err) {
    console.error('[plugins] admin channels health failed:', err);
    res.status(500).json({ error: 'Failed to load channels health' });
  }
});

const retryChannelJobsSchema = z.object({
  job_ids: z.array(z.string().uuid()).min(1).max(100),
});

/**
 * Requeue selected dead-letter jobs after the underlying runtime issue is
 * repaired. This is deliberately admin-triggered and bounded; a deploy must
 * never replay failed provider events implicitly.
 */
adminPluginsRouter.post('/channels/jobs/retry', async (req: any, res) => {
  const parsed = retryChannelJobsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });

  try {
    const sb = getServiceClient(serverConfigOf(req));
    const { data, error } = await sb
      .from('channel_jobs')
      .update({
        status: 'pending',
        attempt_count: 0,
        available_at: new Date().toISOString(),
        claim_token: null,
        claim_expires_at: null,
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .in('id', parsed.data.job_ids)
      .eq('status', 'failed')
      .select('id');
    if (error) throw new Error(error.message);

    console.info(
      `[plugins] platform admin ${req.platformAdminId} requeued ${(data ?? []).length} channel jobs`,
    );
    res.json({ ok: true, requeued: (data ?? []).length });
  } catch (err) {
    console.error('[plugins] admin channel job retry failed:', err);
    res.status(500).json({ error: 'Failed to retry channel jobs' });
  }
});

/**
 * Emergency stop: force-disconnects one integration (removes the provider
 * webhook and the credential). Kept admin-only and explicitly audited.
 */
adminPluginsRouter.post('/channels/integrations/:integrationId/disconnect', async (req: any, res) => {
  const integrationId = String(req.params.integrationId || '');
  try {
    const config = serverConfigOf(req);
    const integration = await getIntegrationById(config, integrationId);
    if (!integration) return res.status(404).json({ error: 'Unknown integration' });
    if (!isBotProvider(integration.provider)) return res.status(400).json({ error: 'Unsupported provider' });

    await requestTelegramDisconnect(config, integration.installation_id, req.platformAdminId ?? null);
    console.warn(
      `[plugins] platform admin ${req.platformAdminId} force-disconnected integration ${integrationId}`,
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[plugins] admin force disconnect failed:', err);
    res.status(502).json({ error: 'Failed to disconnect integration' });
  }
});

/**
 * Platform-wide activity for ONE plugin. Same payload-free contract as the
 * workspace surface, plus the workspace id so an admin can correlate.
 */
adminPluginsRouter.get('/:pluginId/logs', async (req: any, res) => {
  const pluginId = String(req.params.pluginId);
  if (!getPluginDefinition(pluginId)) return res.status(404).json({ error: 'Unknown plugin' });

  try {
    const sb = getServiceClient(serverConfigOf(req));
    const [jobs, inbound] = await Promise.all([
      sb
        .from('channel_jobs')
        .select('id,provider,job_type,status,attempt_count,last_error,created_at,updated_at,workspace_id')
        .eq('provider', pluginId)
        .order('updated_at', { ascending: false })
        .limit(100),
      sb
        .from('channel_inbound_events')
        .select('id,provider,status,last_error,created_at,processed_at,workspace_id')
        .eq('provider', pluginId)
        .order('created_at', { ascending: false })
        .limit(100),
    ]);
    if (jobs.error) throw new Error(jobs.error.message);
    if (inbound.error) throw new Error(inbound.error.message);

    const items = [...(jobs.data ?? []).map(jobLogEntry), ...(inbound.data ?? []).map(inboundLogEntry)]
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 150);
    res.json({ items });
  } catch (err) {
    console.error('[plugins] admin logs failed:', err);
    res.status(500).json({ error: 'Failed to load plugin logs' });
  }
});
