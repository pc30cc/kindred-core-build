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
  storePluginSecret,
} from '../services/plugins/secrets.js';
import {
  buildWebhookUrl,
  createIntegration,
  getIntegrationForInstallation,
  updateIntegration,
} from '../services/channels/integrations.js';
import { connectTelegramBot, disconnectTelegramBot, telegramDiagnostics } from '../services/channels/telegram/setup.js';

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

    await storePluginSecret(config, installation.id, TELEGRAM_BOT_TOKEN_KEY, botToken);

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
      webhookUrl: buildWebhookUrl(config, 'telegram', integration.public_integration_id),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    console.error('[plugins] telegram connect failed:', message);
    res.status(502).json({ error: 'Failed to connect Telegram bot', details: message });
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
            botUsername: integration.external_account_name,
            webhookRegisteredAt: integration.webhook_registered_at,
            lastInboundAt: integration.last_inbound_at,
            lastError: integration.last_error,
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
