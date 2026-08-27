/**
 * Plugin platform state + workspace installations.
 *
 * Source of truth split:
 *   - immutable technical capabilities → server/plugins/registry.ts
 *   - operational platform state       → public.plugin_platform_state
 *   - per-workspace install            → public.workspace_plugin_installations
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { PLUGIN_REGISTRY, getPluginDefinition, type PluginDefinition } from '../../plugins/registry.js';

export type PluginPlatformState = {
  plugin_id: string;
  enabled: boolean;
  marketplace_visible: boolean;
  installable: boolean;
  maintenance_mode: boolean;
  featured: boolean;
  sort_order: number;
  rollout_status: 'hidden' | 'coming_soon' | 'beta' | 'public';
  policy: Record<string, unknown>;
  defaults: Record<string, unknown>;
};

const DEFAULT_STATE = (pluginId: string): PluginPlatformState => {
  const def = getPluginDefinition(pluginId);
  return {
    plugin_id: pluginId,
    enabled: true,
    marketplace_visible: true,
    installable: def?.status === 'available',
    maintenance_mode: false,
    featured: false,
    sort_order: 100,
    rollout_status: def?.status === 'available' ? 'public' : 'coming_soon',
    policy: {},
    defaults: {},
  };
};

export async function listPlatformState(config: ServerConfig): Promise<PluginPlatformState[]> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.from('plugin_platform_state').select('*');
  if (error) throw new Error(`plugin_platform_state read failed: ${error.message}`);
  const byId = new Map((data ?? []).map((r: any) => [r.plugin_id, r as PluginPlatformState]));
  return PLUGIN_REGISTRY.map((p) => byId.get(p.id) ?? DEFAULT_STATE(p.id));
}

export async function getPlatformState(
  config: ServerConfig,
  pluginId: string,
): Promise<PluginPlatformState> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('plugin_platform_state')
    .select('*')
    .eq('plugin_id', pluginId)
    .maybeSingle();
  if (error) throw new Error(`plugin_platform_state read failed: ${error.message}`);
  return (data as PluginPlatformState | null) ?? DEFAULT_STATE(pluginId);
}

const MUTABLE_STATE_FIELDS = [
  'enabled',
  'marketplace_visible',
  'installable',
  'maintenance_mode',
  'featured',
  'sort_order',
  'rollout_status',
  'policy',
  'defaults',
] as const;

export async function updatePlatformState(
  config: ServerConfig,
  pluginId: string,
  patch: Partial<PluginPlatformState>,
  updatedBy: string,
): Promise<PluginPlatformState> {
  const sb = getServiceClient(config);
  const row: Record<string, unknown> = { plugin_id: pluginId, updated_at: new Date().toISOString(), updated_by: updatedBy };
  for (const field of MUTABLE_STATE_FIELDS) {
    if (patch[field] !== undefined) row[field] = patch[field];
  }
  const { data, error } = await sb
    .from('plugin_platform_state')
    .upsert(row, { onConflict: 'plugin_id' })
    .select('*')
    .single();
  if (error) throw new Error(`plugin_platform_state write failed: ${error.message}`);
  return data as PluginPlatformState;
}

// ── Workspace installations ───────────────────────────────────────────

export type PluginInstallation = {
  id: string;
  workspace_id: string;
  plugin_id: string;
  instance_key: string;
  status: 'installed' | 'disabled' | 'uninstalled';
  settings: Record<string, unknown>;
  installed_by: string | null;
  installed_at: string;
  updated_at: string;
};

export async function listInstallations(
  config: ServerConfig,
  workspaceId: string,
): Promise<PluginInstallation[]> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('workspace_plugin_installations')
    .select('*')
    .eq('workspace_id', workspaceId)
    .neq('status', 'uninstalled');
  if (error) throw new Error(`installations read failed: ${error.message}`);
  return (data ?? []) as PluginInstallation[];
}

export async function getInstallation(
  config: ServerConfig,
  workspaceId: string,
  pluginId: string,
  instanceKey = 'default',
): Promise<PluginInstallation | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('workspace_plugin_installations')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('plugin_id', pluginId)
    .eq('instance_key', instanceKey)
    .maybeSingle();
  if (error) throw new Error(`installation read failed: ${error.message}`);
  return (data as PluginInstallation | null) ?? null;
}

export async function installPlugin(
  config: ServerConfig,
  workspaceId: string,
  pluginId: string,
  userId: string,
  instanceKey = 'default',
): Promise<PluginInstallation> {
  const sb = getServiceClient(config);
  const now = new Date().toISOString();
  const { data, error } = await sb
    .from('workspace_plugin_installations')
    .upsert(
      {
        workspace_id: workspaceId,
        plugin_id: pluginId,
        instance_key: instanceKey,
        status: 'installed',
        installed_by: userId,
        installed_at: now,
        updated_at: now,
      },
      { onConflict: 'workspace_id,plugin_id,instance_key' },
    )
    .select('*')
    .single();
  if (error) throw new Error(`install failed: ${error.message}`);
  return data as PluginInstallation;
}

export async function setInstallationStatus(
  config: ServerConfig,
  installationId: string,
  status: PluginInstallation['status'],
): Promise<void> {
  const sb = getServiceClient(config);
  const { error } = await sb
    .from('workspace_plugin_installations')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', installationId);
  if (error) throw new Error(`installation status update failed: ${error.message}`);
}

export async function updateInstallationSettings(
  config: ServerConfig,
  installationId: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const sb = getServiceClient(config);
  const { error } = await sb
    .from('workspace_plugin_installations')
    .update({ settings, updated_at: new Date().toISOString() })
    .eq('id', installationId);
  if (error) throw new Error(`installation settings update failed: ${error.message}`);
}

/** Marketplace view = registry capabilities + platform state, no secrets. */
export function toCatalogEntry(def: PluginDefinition, state: PluginPlatformState) {
  return {
    id: def.id,
    slug: def.slug,
    version: def.version,
    category: def.category,
    status: def.status,
    capabilities: def.capabilities,
    workspaceInstallable: def.workspaceInstallable,
    hasSettings: def.hasSettings,
    supportsInbox: def.supportsInbox,
    supportsAI: def.supportsAI,
    supportsMedia: def.supportsMedia,
    planModuleKey: def.planModuleKey,
    planChannelKey: def.planChannelKey,
    enabled: state.enabled,
    marketplaceVisible: state.marketplace_visible,
    installable: state.installable && def.workspaceInstallable && state.enabled,
    maintenanceMode: state.maintenance_mode,
    featured: state.featured,
    sortOrder: state.sort_order,
    rolloutStatus: state.rollout_status,
  };
}
