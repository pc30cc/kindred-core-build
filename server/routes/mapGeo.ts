/**
 * Platform admin: Map & Geo control surface.
 *
 * Endpoints (all require global admin role):
 *   GET  /api/admin/map-geo/settings           — read merged settings
 *   PUT  /api/admin/map-geo/settings           — patch settings (deep-merge)
 *   GET  /api/admin/map-geo/health             — MaxMind DB + tile config status
 *   POST /api/admin/map-geo/test-resolve       — resolve a test IP locally
 *   POST /api/admin/map-geo/maxmind/run-update — run a real update now
 *   POST /api/admin/map-geo/cache/purge        — purge expired ip_cache rows
 *
 * No external geo or tile vendor is contacted by default. The "Run update"
 * action contacts download.maxmind.com ONLY when the operator has entered
 * their own MaxMind credentials; it downloads to a temp file, validates it and
 * atomically replaces the live .mmdb. Operators who prefer host-side
 * `geoipupdate` can simply leave auto-update off — the mounted file is
 * hot-reloaded either way.
 */
import { Router } from 'express';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { getMapGeoSettings, patchMapGeoSettings } from '../services/geo/settings.js';
import { checkMaxmindLocalHealth, lookupMaxmindLocal } from '../services/geo/maxmindLocal.js';
import { purgeExpiredIpCache } from '../services/geo/ipCache.js';
import { resolveMapTilesConfig } from '../services/maptiles/index.js';
import { runMaxmindUpdateNow, MIN_INTERVAL_HOURS } from '../services/geo/maxmindUpdater.js';
import { requirePlatformAdmin } from '../lib/workspaceAuth.js';

export const mapGeoRouter = Router();

async function requireAdmin(req: any, res: any, next: any) {
  const userId = await requirePlatformAdmin(req, res);
  if (!userId) return;
  (req as any).adminUser = { id: userId };
  next();
}

mapGeoRouter.use(requireAdmin);

// ─── GET settings ────────────────────────────────────────────────
mapGeoRouter.get('/settings', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const settings = await getMapGeoSettings(config);
    // Never expose the license key in API reads — return a redacted marker.
    const safe = {
      ...settings,
      maxmind_update: {
        ...settings.maxmind_update,
        license_key: settings.maxmind_update.license_key ? '••••••••' : '',
      },
    };
    res.json({ settings: safe });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to load settings' });
  }
});

// ─── PUT settings (deep-merge patch) ─────────────────────────────
const settingsPatchSchema = z.object({
  geo: z.object({
    enabled: z.boolean().optional(),
    default_provider: z.string().optional(),
    preferred_precision: z.enum(['country', 'region', 'city']).optional(),
    allow_centroid_fallback: z.boolean().optional(),
    min_accuracy_for_map: z.enum(['country', 'region', 'city']).optional(),
    store_raw_ip: z.boolean().optional(),
    raw_ip_retention_days: z.number().int().min(0).max(365).optional(),
    auto_enrich_on_session_create: z.boolean().optional(),
    cache_ttl_seconds: z.number().int().min(60).optional(),
  }).partial().optional(),
  maxmind_local: z.object({
    enabled: z.boolean().optional(),
    db_path: z.string().optional(),
    auto_reload: z.boolean().optional(),
    cache_ttl_seconds: z.number().int().min(60).optional(),
  }).partial().optional(),
  maxmind_update: z.object({
    mode: z.enum(['manual', 'auto']).optional(),
    account_id: z.string().optional(),
    license_key: z.string().optional(),
    edition_id: z.string().optional(),
    interval_hours: z.number().int().min(1).max(8760).optional(),
  }).partial().optional(),
  tiles: z.object({
    provider: z.string().optional(),
    url_template: z.string().optional(),
    attribution: z.string().optional(),
    min_zoom: z.number().int().min(0).max(24).optional(),
    max_zoom: z.number().int().min(0).max(24).optional(),
    subdomains: z.string().optional(),
  }).partial().optional(),
  behavior: z.object({
    show_only_valid_coords: z.boolean().optional(),
    ignore_fallback_only: z.boolean().optional(),
    include_geo_labels: z.boolean().optional(),
    debug_metadata: z.boolean().optional(),
    default_center_mode: z.enum(['auto', 'fixed']).optional(),
    default_center_lat: z.number().optional(),
    default_center_lng: z.number().optional(),
    default_zoom: z.number().int().min(0).max(22).optional(),
  }).partial().optional(),
  display: z.object({
    height_px: z.number().int().min(240).max(2000).optional(),
    fill_viewport: z.boolean().optional(),
  }).partial().optional(),
}).strict();

mapGeoRouter.put('/settings', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const patch = settingsPatchSchema.parse(req.body);
    // If client sends the redacted marker, drop it so we don't overwrite the real key.
    if (patch.maxmind_update?.license_key === '••••••••') {
      delete patch.maxmind_update.license_key;
    }
    const merged = await patchMapGeoSettings(config, patch as any);
    // Audit
    const sb = getServiceClient(config);
    await sb.from('audit_logs').insert({
      action: 'map_geo.settings.update',
      entity_type: 'app_runtime_config',
      entity_id: null,
      user_id: (req as any).adminUser.id,
      workspace_id: '00000000-0000-0000-0000-000000000000',
      new_value: { keys: Object.keys(patch) } as any,
    } as any).then(() => {}, () => {});
    const safe = {
      ...merged,
      maxmind_update: { ...merged.maxmind_update, license_key: merged.maxmind_update.license_key ? '••••••••' : '' },
    };
    res.json({ settings: safe });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Invalid settings' });
  }
});

// ─── Health ──────────────────────────────────────────────────────
mapGeoRouter.get('/health', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const settings = await getMapGeoSettings(config);
    const enabled = settings.maxmind_local.enabled;
    const dbPath = settings.maxmind_local.db_path;
    const dbHealth = enabled && dbPath
      ? await checkMaxmindLocalHealth(dbPath)
      : {
          ok: false,
          file_exists: false,
          readable: false,
          usable: false,
          error: enabled ? 'No database path configured' : 'MaxMind Local is disabled',
        };
    const upd = settings.maxmind_update;
    const autoUpdateEnabled = upd.mode === 'auto' && !!upd.account_id && !!upd.license_key;
    // Loud, explicit degradation signal — never let the admin believe geo is
    // city-accurate while we are silently serving centroids.
    const degraded = enabled && !dbHealth.ok;
    const tiles = await resolveMapTilesConfig(config, null);
    res.json({
      maxmind_local: {
        enabled,
        db_path: dbPath,
        ...dbHealth,
      },
      maxmind_update: {
        mode: upd.mode,
        enabled: autoUpdateEnabled,
        has_credentials: !!upd.account_id && !!upd.license_key,
        edition_id: upd.edition_id,
        interval_hours: Math.max(MIN_INTERVAL_HOURS, Number(upd.interval_hours) || MIN_INTERVAL_HOURS),
        min_interval_hours: MIN_INTERVAL_HOURS,
        last_run_at: upd.last_run_at,
        last_status: upd.last_status,
        last_error: upd.last_error,
      },
      degraded,
      degraded_reason: degraded
        ? 'MaxMind Local is enabled but the database file is unavailable. Geo resolution is currently using fallback sources.'
        : null,
      tiles: {
        configured: !!tiles.tile_url,
        health_status: tiles.health_status,
        resolved_provider: tiles.resolved_provider,
        fallback_reason: tiles.fallback_reason,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Health check failed' });
  }
});

// ─── Test resolve ────────────────────────────────────────────────
const testSchema = z.object({ ip: z.string().min(1) });

mapGeoRouter.post('/test-resolve', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const { ip } = testSchema.parse(req.body);
    const settings = await getMapGeoSettings(config);
    if (!settings.maxmind_local.enabled || !settings.maxmind_local.db_path) {
      return res.json({ ok: false, error: 'maxmind_local disabled or no DB path' });
    }
    const result = await lookupMaxmindLocal(settings.maxmind_local.db_path, ip, {
      autoReload: settings.maxmind_local.auto_reload,
    });
    if (!result) return res.json({ ok: false, error: 'No data for this IP', ip_hash: createHash('sha256').update(ip).digest('hex').slice(0, 16) });
    res.json({
      ok: true,
      provider: 'maxmind_local',
      ip_hash: createHash('sha256').update(ip).digest('hex').slice(0, 16) + '…',
      ...result,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Test failed' });
  }
});

// ─── MaxMind manual update — guidance only (host-side cron is the recommended path) ──
mapGeoRouter.post('/maxmind/run-update', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const settings = await getMapGeoSettings(config);
  const sb = getServiceClient(config);
  await sb.from('audit_logs').insert({
    action: 'map_geo.maxmind.update_requested',
    entity_type: 'app_runtime_config',
    user_id: (req as any).adminUser.id,
    workspace_id: '00000000-0000-0000-0000-000000000000',
    new_value: { edition_id: settings.maxmind_update.edition_id } as any,
  } as any).then(() => {}, () => {});

  // Runs the same code path as the ticker: leased, atomic, validated.
  // Credentials never appear in the response or the audit payload.
  const outcome = await runMaxmindUpdateNow(config);
  res.json({
    ok: outcome.ok,
    status: outcome.status,
    reason: outcome.reason ?? null,
    db_path: settings.maxmind_local.db_path,
    edition_id: settings.maxmind_update.edition_id,
    size_bytes: outcome.size_bytes ?? null,
  });
});

// ─── Cache purge ─────────────────────────────────────────────────
mapGeoRouter.post('/cache/purge', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const purged = await purgeExpiredIpCache(config);
    res.json({ ok: true, purged });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Purge failed' });
  }
});