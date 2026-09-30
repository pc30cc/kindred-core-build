/**
 * Platform support — the singleton switch Super Admin sets.
 *
 * `platform_support_settings` (migrations 242, 243): whether operators may
 * reach the platform's team at all, and which workspace answers them. Read
 * on every support request, so kept for a short while in memory and dropped
 * the moment Super Admin saves.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export interface PlatformSupportSettings {
  enabled: boolean;
  /** The workspace whose inbox receives support; null until one is chosen. */
  workspaceId: string | null;
  updatedAt: string | null;
}

export const PLATFORM_SUPPORT_DEFAULTS: PlatformSupportSettings = {
  enabled: false,
  workspaceId: null,
  updatedAt: null,
};

const CACHE_MS = 30_000;
let cache: { at: number; value: PlatformSupportSettings } | null = null;

interface SettingsRow {
  enabled: boolean | null;
  workspace_id: string | null;
  updated_at: string | null;
}

const COLUMNS = 'enabled, workspace_id, updated_at';

export function normalizeSettings(row: Partial<SettingsRow> | null | undefined): PlatformSupportSettings {
  if (!row) return { ...PLATFORM_SUPPORT_DEFAULTS };
  return {
    enabled: row.enabled === true,
    workspaceId: row.workspace_id || null,
    updatedAt: row.updated_at || null,
  };
}

export function invalidatePlatformSupportSettings(): void {
  cache = null;
}

export async function loadPlatformSupportSettings(config: ServerConfig): Promise<PlatformSupportSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const { data, error } = await getServiceClient(config)
    .from('platform_support_settings')
    .select(COLUMNS)
    .eq('id', true)
    .maybeSingle();
  // A failed read is "off", never a cached "off": the next request asks again.
  if (error) {
    console.warn('[platform-support] settings read failed:', error.message);
    return { ...PLATFORM_SUPPORT_DEFAULTS };
  }
  const value = normalizeSettings(data as SettingsRow | null);
  cache = { at: Date.now(), value };
  return value;
}

export interface PlatformSupportSettingsPatch {
  enabled?: boolean;
  workspaceId?: string | null;
}

export async function savePlatformSupportSettings(
  config: ServerConfig,
  patch: PlatformSupportSettingsPatch,
  actorId: string,
): Promise<PlatformSupportSettings> {
  const row: Record<string, unknown> = { id: true, updated_at: new Date().toISOString(), updated_by: actorId };
  if (patch.enabled !== undefined) row.enabled = patch.enabled;
  if (patch.workspaceId !== undefined) row.workspace_id = patch.workspaceId;
  const { data, error } = await getServiceClient(config)
    .from('platform_support_settings')
    .upsert(row, { onConflict: 'id' })
    .select(COLUMNS)
    .single();
  invalidatePlatformSupportSettings();
  if (error) throw new Error(`platform support settings save failed: ${error.message}`);
  return normalizeSettings(data as SettingsRow);
}
