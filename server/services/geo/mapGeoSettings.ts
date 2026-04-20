/**
 * Platform-level Map & Geo settings service.
 *
 * Responsible for:
 *   - reading the canonical map_geo_settings runtime config (delegates to
 *     the resolver in geo/index.ts so the in-process 30s memo is shared)
 *   - validating + safely merging admin updates without wiping unrelated
 *     branches of the JSON document
 *   - writing platform audit log rows when settings change
 *
 * All write paths assume the caller is a verified platform admin
 * (enforced in routes/admin.ts via requireAdmin).
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import {
  getMapGeoSettings,
  invalidateMapGeoSettingsCache,
  type MapGeoSettings,
} from './index.js';

const PRECISIONS = new Set(['country', 'region', 'city']);
const CENTER_MODES = new Set(['auto', 'manual']);

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function toBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1 || v === '1') return true;
  if (v === 'false' || v === 0 || v === '0') return false;
  return fallback;
}

/**
 * Validate + merge an admin patch on top of the current settings.
 * Unknown fields are dropped; numeric/enum fields are coerced + clamped.
 * The shape of the returned object exactly matches MapGeoSettings.
 */
export function mergeMapGeoPatch(
  current: MapGeoSettings,
  patch: any,
): MapGeoSettings {
  const p = (patch && typeof patch === 'object') ? patch : {};
  const mm = (p.maxmind_local && typeof p.maxmind_local === 'object') ? p.maxmind_local : {};
  const map = (p.map && typeof p.map === 'object') ? p.map : {};
  const jobs = (p.jobs && typeof p.jobs === 'object') ? p.jobs : {};

  const dbPath = typeof mm.db_path === 'string' ? mm.db_path.trim() : current.maxmind_local.db_path;

  return {
    enabled: toBool(p.enabled, current.enabled),
    default_provider: typeof p.default_provider === 'string' && p.default_provider.length
      ? p.default_provider.trim().toLowerCase()
      : current.default_provider,
    preferred_precision: PRECISIONS.has(p.preferred_precision)
      ? p.preferred_precision : current.preferred_precision,
    allow_centroid_fallback: toBool(p.allow_centroid_fallback, current.allow_centroid_fallback),
    min_accuracy_for_map: PRECISIONS.has(p.min_accuracy_for_map)
      ? p.min_accuracy_for_map : current.min_accuracy_for_map,
    store_raw_ip: toBool(p.store_raw_ip, current.store_raw_ip),
    raw_ip_retention_days: clampInt(p.raw_ip_retention_days, 1, 365, current.raw_ip_retention_days),
    auto_enrich_on_session_create: toBool(
      p.auto_enrich_on_session_create, current.auto_enrich_on_session_create,
    ),
    maxmind_local: {
      enabled: toBool(mm.enabled, current.maxmind_local.enabled),
      db_path: dbPath || current.maxmind_local.db_path,
      auto_reload: toBool(mm.auto_reload, current.maxmind_local.auto_reload),
      cache_ttl_seconds: clampInt(
        mm.cache_ttl_seconds, 60, 7 * 24 * 3600, current.maxmind_local.cache_ttl_seconds,
      ),
    },
    map: {
      show_only_valid_coords: toBool(map.show_only_valid_coords, current.map.show_only_valid_coords),
      ignore_fallback_only_points: toBool(
        map.ignore_fallback_only_points, current.map.ignore_fallback_only_points,
      ),
      default_center_mode: CENTER_MODES.has(map.default_center_mode)
        ? map.default_center_mode : current.map.default_center_mode,
      default_lat: clampNum(map.default_lat, -90, 90, current.map.default_lat),
      default_lng: clampNum(map.default_lng, -180, 180, current.map.default_lng),
      default_zoom: clampInt(map.default_zoom, 0, 22, current.map.default_zoom),
      include_geo_labels: toBool(map.include_geo_labels, current.map.include_geo_labels),
      debug_mode: toBool(map.debug_mode, current.map.debug_mode),
    },
    jobs: {
      warm_lookback_days: clampInt(jobs.warm_lookback_days, 1, 90, current.jobs.warm_lookback_days),
      warm_limit: clampInt(jobs.warm_limit, 1, 5000, current.jobs.warm_limit),
      warm_force_reenrich: toBool(jobs.warm_force_reenrich, current.jobs.warm_force_reenrich),
    },
  };
}

/**
 * Compute a shallow diff between two MapGeoSettings objects so audit
 * payloads stay small + readable. Only changed leaf keys are recorded.
 */
export function diffSettings(
  before: MapGeoSettings, after: MapGeoSettings,
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  const walk = (a: any, b: any, prefix: string) => {
    const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
    for (const k of keys) {
      const av = a?.[k], bv = b?.[k];
      if (av && typeof av === 'object' && !Array.isArray(av) && bv && typeof bv === 'object') {
        walk(av, bv, `${prefix}${k}.`);
      } else if (JSON.stringify(av) !== JSON.stringify(bv)) {
        out[`${prefix}${k}`] = { from: av ?? null, to: bv ?? null };
      }
    }
  };
  walk(before, after, '');
  return out;
}

/**
 * Persist new settings + invalidate the in-process resolver cache so
 * subsequent geo lookups pick up the change immediately.
 */
export async function writeMapGeoSettings(
  config: ServerConfig,
  next: MapGeoSettings,
): Promise<void> {
  const sb = getServiceClient(config);
  const { error } = await sb
    .from('app_runtime_config')
    .upsert(
      { key: 'map_geo_settings', value: next as any, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
  if (error) throw new Error(`Failed to persist map_geo_settings: ${error.message}`);
  invalidateMapGeoSettingsCache();
}

/**
 * Best-effort platform audit log entry. We don't have a workspace_id for
 * platform-wide settings, and audit_logs.workspace_id is NOT NULL — so
 * we log into a console trail and a best-effort row only when a
 * "platform" sentinel workspace exists. Today the row is skipped if
 * none exists; the console trail is always emitted.
 */
export async function writeMapGeoAudit(
  config: ServerConfig,
  args: {
    userId: string;
    action: 'map_geo.settings.updated' | 'map_geo.settings.read' | 'map_geo.test_ip' | 'map_geo.maxmind.status_checked';
    diff?: Record<string, { from: unknown; to: unknown }>;
    metadata?: Record<string, unknown>;
    ip?: string | null;
  },
): Promise<void> {
  // Always emit a structured log line so operators can grep deployment logs.
  console.info('[audit:map_geo]', JSON.stringify({
    action: args.action,
    user_id: args.userId,
    ip: args.ip ?? null,
    diff_keys: args.diff ? Object.keys(args.diff) : undefined,
  }));

  // Skip DB write for read-only events to keep audit table noise low.
  if (args.action === 'map_geo.settings.read' || args.action === 'map_geo.maxmind.status_checked') return;

  try {
    const sb = getServiceClient(config);
    // Find any workspace owned by the actor as a best-effort scope target.
    // Platform-wide settings don't belong to a workspace, but audit_logs
    // requires one. We anchor to the actor's first workspace so the row is
    // discoverable in their audit history.
    const { data: ws } = await sb
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', args.userId)
      .limit(1)
      .maybeSingle();
    if (!ws?.workspace_id) return;

    await sb.from('audit_logs').insert({
      workspace_id: ws.workspace_id,
      user_id: args.userId,
      entity_type: 'platform_map_geo',
      entity_id: null,
      action: args.action,
      new_value: { diff: args.diff ?? null, metadata: args.metadata ?? null } as any,
      ip_address: args.ip || null,
    });
  } catch (err) {
    console.warn('[audit:map_geo] insert failed:', (err as Error).message);
  }
}

export { getMapGeoSettings };