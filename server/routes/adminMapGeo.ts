/**
 * PLATFORM ADMIN — Map & Geo control surface.
 *
 * Mounted at /api/admin/map-geo from server/routes/admin.ts (which already
 * runs the global requireAdmin middleware). All routes here are platform
 * admin only; workspace-scoped behavior is handled separately by the
 * existing /api/visitor-intel/* operator routes.
 */
import { Router } from 'express';
import { z } from 'zod';
import * as net from 'node:net';
import type { ServerConfig } from '../config.js';
import {
  getMapGeoSettings,
  resolveVisitorGeo,
  getActiveGeoProvider,
} from '../services/geo/index.js';
import { checkMaxmindLocalHealth } from '../services/geo/maxmindLocal.js';
import {
  mergeMapGeoPatch,
  diffSettings,
  writeMapGeoSettings,
  writeMapGeoAudit,
} from '../services/geo/mapGeoSettings.js';
import { getClientIp, hashIp } from '../utils/clientIp.js';

export const adminMapGeoRouter = Router();

// ─── GET /api/admin/map-geo/settings ─────────────────────────────
adminMapGeoRouter.get('/settings', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  try {
    const settings = await getMapGeoSettings(config);
    res.json({ settings });
  } catch (err: any) {
    console.error('[admin.map-geo] read failed:', err);
    res.status(500).json({ error: 'Failed to read map_geo_settings' });
  }
});

// ─── PUT /api/admin/map-geo/settings ─────────────────────────────
adminMapGeoRouter.put('/settings', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const adminUser = (req as any).adminUser as { id: string } | undefined;

  try {
    const before = await getMapGeoSettings(config);
    const next = mergeMapGeoPatch(before, req.body ?? {});
    const diff = diffSettings(before, next);

    if (Object.keys(diff).length === 0) {
      return res.json({ settings: next, changed: false });
    }

    await writeMapGeoSettings(config, next);
    await writeMapGeoAudit(config, {
      userId: adminUser?.id ?? 'unknown',
      action: 'map_geo.settings.updated',
      diff,
      ip: getClientIp(req),
    });

    res.json({ settings: next, changed: true, diff });
  } catch (err: any) {
    console.error('[admin.map-geo] update failed:', err);
    res.status(400).json({ error: err?.message || 'Failed to update settings' });
  }
});

// ─── POST /api/admin/map-geo/test-ip ─────────────────────────────
const testIpSchema = z.object({
  ip: z.string().min(3).max(64),
  workspace_id: z.string().uuid().optional(),
});

adminMapGeoRouter.post('/test-ip', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  try {
    const parsed = testIpSchema.parse(req.body);
    const ip = parsed.ip.trim();
    if (!net.isIP(ip)) {
      return res.status(400).json({ error: 'Invalid IP address' });
    }

    const settings = await getMapGeoSettings(config);
    const active = await getActiveGeoProvider(config, parsed.workspace_id ?? null);

    // Run through the real pipeline. Pass raw IP so providers fire.
    const start = Date.now();
    const result = await resolveVisitorGeo(config, parsed.workspace_id ?? null, {
      ip_hash: hashIp(ip),
      raw_ip: ip,
    });
    const duration_ms = Date.now() - start;

    // Best-effort fallback reason for the diagnostics panel.
    let fallback_reason: string | null = null;
    if (result.is_fallback) {
      if (result.source === 'centroid') {
        fallback_reason = settings.maxmind_local.enabled
          ? 'No provider returned a hit — centroid used. Check MaxMind DB or provider config.'
          : 'MaxMind Local disabled and no other provider returned a hit — centroid used.';
      } else if (result.source === 'session') {
        fallback_reason = 'Only session metadata available — no coordinates resolved.';
      } else if (result.source === 'disabled') {
        fallback_reason = 'Geo enrichment disabled in map_geo_settings.';
      } else if (result.source === 'none') {
        fallback_reason = 'No provider configured and centroid fallback disabled.';
      }
    }

    res.json({
      result: {
        ...result,
        ip_echo: ip, // echo for UI confirmation; never persisted
        duration_ms,
      },
      active_provider: active,
      settings_snapshot: {
        preferred_precision: settings.preferred_precision,
        allow_centroid_fallback: settings.allow_centroid_fallback,
        maxmind_enabled: settings.maxmind_local.enabled,
      },
      fallback_reason,
    });
  } catch (err: any) {
    console.error('[admin.map-geo] test-ip failed:', err);
    res.status(400).json({ error: err?.message || 'Test failed' });
  }
});

// ─── GET /api/admin/map-geo/maxmind/status ───────────────────────
adminMapGeoRouter.get('/maxmind/status', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  try {
    const settings = await getMapGeoSettings(config);
    const dbPath = settings.maxmind_local.db_path;
    const enabled = settings.maxmind_local.enabled;

    if (!enabled) {
      return res.json({
        enabled: false,
        configured: !!dbPath,
        db_path: dbPath,
        file_exists: false,
        readable: false,
        usable: false,
        size_bytes: null,
        mtime: null,
        error: null,
      });
    }

    const health = await checkMaxmindLocalHealth(dbPath);
    res.json({
      enabled: true,
      configured: !!dbPath,
      db_path: dbPath,
      file_exists: health.ok || (health.error ? !/no such file/i.test(health.error) : false),
      readable: health.ok,
      usable: health.ok,
      size_bytes: health.size_bytes ?? null,
      mtime: health.mtime ?? null,
      error: health.ok ? null : (health.error ?? 'Unknown error'),
    });
  } catch (err: any) {
    console.error('[admin.map-geo] maxmind status failed:', err);
    res.status(500).json({ error: err?.message || 'Status check failed' });
  }
});

// ─── POST /api/admin/map-geo/warm-geo (platform-level, all workspaces) ─
// Re-uses the existing per-workspace logic by iterating over every
// workspace that has recent sessions. Returns aggregated stats.
adminMapGeoRouter.post('/warm-geo', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  try {
    const { getServiceClient } = await import('../supabase.js');
    const { resolveVisitorGeo, persistSessionGeo } = await import('../services/geo/index.js');
    const sb = getServiceClient(config);
    const lookbackDays = Math.min(Math.max(Number(req.body?.lookback_days ?? 7), 1), 90);
    const limit = Math.min(Math.max(Number(req.body?.limit ?? 500), 1), 5000);
    const force = req.body?.force === true || req.body?.force === '1';
    const since = new Date(Date.now() - lookbackDays * 86400_000).toISOString();

    const { data: sessions, error } = await sb
      .from('visitor_sessions')
      .select('id, workspace_id, country, city, ip_hash, ip_raw, geo_accuracy_level, geo_is_fallback')
      .gte('last_seen_at', since)
      .order('last_seen_at', { ascending: false })
      .limit(limit);
    if (error) throw error;

    const counts = {
      scanned: 0, enriched: 0,
      skipped_no_raw_ip: 0, skipped_already_good: 0,
      failed: 0, fallback_count: 0,
    };

    for (const s of sessions ?? []) {
      counts.scanned++;
      if (!force && s.geo_accuracy_level === 'city' && s.geo_is_fallback === false) {
        counts.skipped_already_good++;
        continue;
      }
      const rawIp = (s as any).ip_raw as string | null;
      if (!rawIp) { counts.skipped_no_raw_ip++; continue; }
      try {
        const result = await resolveVisitorGeo(config, s.workspace_id, {
          country: s.country, city: s.city, ip_hash: s.ip_hash, raw_ip: rawIp,
        });
        await persistSessionGeo(config, s.id, result);
        if (result.is_fallback) counts.fallback_count++;
        else counts.enriched++;
      } catch {
        counts.failed++;
      }
    }

    res.json({ status: 'ok', lookback_days: lookbackDays, ...counts });
  } catch (err: any) {
    console.error('[admin.map-geo] warm-geo failed:', err);
    res.status(500).json({ error: err?.message || 'Warm geo failed' });
  }
});