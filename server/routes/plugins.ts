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
import { checkModuleAccess } from '../middleware/featureGating.js';
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
  TELEGRAM_BOT_TOKEN_KEY,
  deletePluginSecret,
  hasPluginSecret,
  pluginCryptoReady,
} from '../services/plugins/secrets.js';
import {
  buildWebhookUrl,
  createIntegration,
  getIntegrationById,
  getIntegrationForInstallation,
} from '../services/channels/integrations.js';
import {
  TelegramConnectError,
  applyTelegramProfile,
  connectTelegramBot,
  disconnectTelegramBot,
  repairTelegramWebhook,
  telegramDiagnostics,
} from '../services/channels/telegram/setup.js';
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

/** A plugin is usable only when platform state AND the plan both allow it. */
async function resolveAvailability(req: any, workspaceId: string, pluginId: string) {
  const config = serverConfigOf(req);
  const def = getPluginDefinition(pluginId);
  if (!def) return { ok: false as const, reason: 'unknown_plugin' };

  const state = await getPlatformState(config, pluginId);
  if (!state.enabled) return { ok: false as const, reason: 'disabled_by_platform' };
  if (state.maintenance_mode) return { ok: false as const, reason: 'maintenance_mode' };
  if (!state.installable || !def.workspaceInstallable) return { ok: false as const, reason: 'not_installable' };

  if (def.planModuleKey) {
    const entitlement = await checkModuleAccess(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      workspaceId,
      def.planModuleKey,
    );
    if (!entitlement.allowed) return { ok: false as const, reason: 'plan_locked' };
  }
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
        let planAllowed = true;
        if (def.planModuleKey) {
          const entitlement = await checkModuleAccess(
            config.supabaseUrl,
            config.supabaseServiceRoleKey,
            workspaceId,
            def.planModuleKey,
          );
          planAllowed = entitlement.allowed;
        }
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
    if (pluginId === 'telegram') await disconnectTelegramBot(config, installation.id);

    await deletePluginSecret(config, installation.id, TELEGRAM_BOT_TOKEN_KEY);
    await setInstallationStatus(config, installation.id, 'uninstalled');
    res.json({ ok: true });
  } catch (err) {
    console.error('[plugins] uninstall failed:', err);
    res.status(500).json({ error: 'Failed to uninstall plugin' });
  }
});

// ── Telegram configuration ────────────────────────────────────────────

const telegramConnectSchema = z.object({
  workspace_id: z.string().uuid(),
  bot_token: z.string().min(20).max(200).regex(/^\d{6,}:[A-Za-z0-9_-]{20,}$/, 'Invalid bot token format'),
});

pluginsRouter.post('/telegram/connect', async (req: any, res) => {
  const parsed = telegramConnectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid bot token' });
  const { workspace_id: workspaceId, bot_token: botToken } = parsed.data;

  const auth = await requireManager(req, res, workspaceId);
  if (!auth) return;

  try {
    const config = serverConfigOf(req);
    if (!pluginCryptoReady(config)) {
      return res.status(503).json({ error: 'Credential encryption is not configured on this server' });
    }
    if (!config.channelsWebhookSigningKey || !config.publicChannelsBaseUrl) {
      return res.status(503).json({ error: 'Channels runtime is not configured on this server' });
    }

    const availability = await resolveAvailability(req, workspaceId, 'telegram');
    if (!availability.ok) return res.status(403).json({ error: 'Plugin unavailable', reason: availability.reason });

    const installation =
      (await getInstallation(config, workspaceId, 'telegram')) ??
      (await installPlugin(config, workspaceId, 'telegram', auth.userId));
    if (installation.status !== 'installed') {
      await setInstallationStatus(config, installation.id, 'installed');
    }

    const integration =
      (await getIntegrationForInstallation(config, installation.id)) ??
      (await createIntegration(config, {
        workspaceId,
        installationId: installation.id,
        provider: 'telegram',
      }));

    const result = await connectTelegramBot(config, integration, botToken);
    res.json({
      ok: true,
      hasToken: true,
      bot: result.bot,
      verifiedAt: result.verifiedAt,
      webhookUrl: result.webhookUrl,
    });
  } catch (err) {
    if (err instanceof TelegramConnectError) {
      const status = err.code === 'duplicate_bot' ? 409 : err.code === 'not_configured' ? 503 : 502;
      console.error(`[plugins] telegram connect failed: ${err.code}`);
      return res.status(status).json({ error: 'telegram_connect_failed', reason: err.code });
    }
    const message = err instanceof Error ? err.message : 'unknown error';
    console.error('[plugins] telegram connect failed:', message);
    res.status(502).json({ error: 'telegram_connect_failed', reason: 'unexpected_error' });
  }
});

pluginsRouter.get('/telegram/status', async (req: any, res) => {
  const workspaceId = String(req.query.workspace_id || '');
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
  const auth = await requireManager(req, res, workspaceId);
  if (!auth) return;

  try {
    const config = serverConfigOf(req);
    const installation = await getInstallation(config, workspaceId, 'telegram');
    if (!installation || installation.status === 'uninstalled') {
      return res.json({ installed: false });
    }
    const integration = await getIntegrationForInstallation(config, installation.id);
    res.json({
      installed: true,
      status: installation.status,
      settings: installation.settings ?? {},
      hasToken: await hasPluginSecret(config, installation.id, TELEGRAM_BOT_TOKEN_KEY),
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
              ? buildWebhookUrl(config, 'telegram', integration.public_integration_id)
              : null,
          }
        : null,
    });
  } catch (err) {
    console.error('[plugins] telegram status failed:', err);
    res.status(500).json({ error: 'Failed to load Telegram status' });
  }
});

pluginsRouter.post('/telegram/diagnostics', async (req: any, res) => {
  const workspaceId = String(req.body?.workspace_id || '');
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
  const auth = await requireManager(req, res, workspaceId);
  if (!auth) return;

  try {
    const config = serverConfigOf(req);
    const installation = await getInstallation(config, workspaceId, 'telegram');
    if (!installation) return res.status(404).json({ error: 'Telegram is not installed' });
    res.json(await telegramDiagnostics(config, installation.id));
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
pluginsRouter.post('/telegram/reconnect', async (req: any, res) => {
  const workspaceId = String(req.body?.workspace_id || '');
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
  const auth = await requireManager(req, res, workspaceId);
  if (!auth) return;

  try {
    const config = serverConfigOf(req);
    const installation = await getInstallation(config, workspaceId, 'telegram');
    if (!installation) return res.status(404).json({ error: 'not_installed' });

    const result = await repairTelegramWebhook(config, installation.id);
    if (!result.repaired) return res.status(502).json({ error: 'repair_failed', reason: result.reason });
    res.json({ ok: true });
  } catch (err) {
    console.error('[plugins] telegram reconnect failed:', err);
    res.status(502).json({ error: 'repair_failed', reason: 'unexpected_error' });
  }
});

/**
 * Disconnect: removes the provider webhook and the stored credential but
 * KEEPS the installation and all conversation history.
 */
pluginsRouter.post('/telegram/disconnect', async (req: any, res) => {
  const workspaceId = String(req.body?.workspace_id || '');
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id is required' });
  const auth = await requireManager(req, res, workspaceId);
  if (!auth) return;

  try {
    const config = serverConfigOf(req);
    const installation = await getInstallation(config, workspaceId, 'telegram');
    if (!installation) return res.json({ ok: true });

    await disconnectTelegramBot(config, installation.id);
    await deletePluginSecret(config, installation.id, TELEGRAM_BOT_TOKEN_KEY);
    res.json({ ok: true });
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

pluginsRouter.post('/telegram/profile', async (req: any, res) => {
  const parsed = telegramProfileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_profile' });
  const auth = await requireManager(req, res, parsed.data.workspace_id);
  if (!auth) return;

  try {
    const config = serverConfigOf(req);
    const installation = await getInstallation(config, parsed.data.workspace_id, 'telegram');
    if (!installation) return res.status(404).json({ error: 'not_installed' });

    const result = await applyTelegramProfile(config, installation.id, {
      name: parsed.data.name,
      shortDescription: parsed.data.short_description,
      description: parsed.data.description,
      commands: parsed.data.commands?.map((c) => ({
        command: String(c.command),
        description: String(c.description),
      })),
    });
    res.json({ ok: true, ...result });
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
    await updateInstallationSettings(config, installation.id, settings);
    res.json({ ok: true });
  } catch (err) {
    console.error('[plugins] settings update failed:', err);
    res.status(500).json({ error: 'Failed to update plugin settings' });
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
    if (integration.provider !== 'telegram') return res.status(400).json({ error: 'Unsupported provider' });

    await disconnectTelegramBot(config, integration.installation_id);
    await deletePluginSecret(config, integration.installation_id, TELEGRAM_BOT_TOKEN_KEY);
    console.warn(
      `[plugins] platform admin ${req.platformAdminId} force-disconnected integration ${integrationId}`,
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[plugins] admin force disconnect failed:', err);
    res.status(502).json({ error: 'Failed to disconnect integration' });
  }
});
