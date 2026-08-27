/**
 * Plugin Platform — workspace + Super Admin client API.
 *
 * Credentials are write-only by design: a bot token can be submitted but is
 * never returned. The UI must rely on `hasToken` and never try to display or
 * cache a secret value.
 */

import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';

const API_BASE = RESOLVED_API_BASE || '';

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) {
    const err: any = new Error(body?.details || body?.error || `HTTP ${res.status}`);
    err.code = body?.reason || body?.error || null;
    err.status = res.status;
    throw err;
  }
  return body as T;
}

export type PluginRolloutStatus = 'hidden' | 'coming_soon' | 'beta' | 'public';

export interface PluginCatalogItem {
  id: string;
  slug: string;
  version: string;
  category: string;
  status: 'available' | 'coming_soon';
  capabilities: string[];
  workspaceInstallable: boolean;
  hasSettings: boolean;
  supportsInbox: boolean;
  supportsAI: boolean;
  supportsMedia: boolean;
  planModuleKey: string | null;
  enabled: boolean;
  marketplaceVisible: boolean;
  installable: boolean;
  maintenanceMode: boolean;
  featured: boolean;
  sortOrder: number;
  rolloutStatus: PluginRolloutStatus;
  planAllowed: boolean;
  installed: boolean;
  installationStatus: string | null;
  installationId: string | null;
}

export interface TelegramStatus {
  installed: boolean;
  status?: string;
  settings?: Record<string, unknown>;
  hasToken?: boolean;
  integration?: {
    status: string;
    botUsername: string | null;
    webhookRegisteredAt: string | null;
    lastInboundAt: string | null;
    lastError: string | null;
    webhookUrl: string | null;
  } | null;
}

export const pluginsApi = {
  catalog: (workspaceId: string) =>
    jsonFetch<{ items: PluginCatalogItem[] }>(
      `/api/plugins/catalog?workspace_id=${encodeURIComponent(workspaceId)}`,
    ),

  install: (workspaceId: string, pluginId: string) =>
    jsonFetch<{ installation: { id: string; pluginId: string; status: string } }>(
      '/api/plugins/install',
      { method: 'POST', body: JSON.stringify({ workspace_id: workspaceId, plugin_id: pluginId }) },
    ),

  uninstall: (workspaceId: string, pluginId: string) =>
    jsonFetch<{ ok: true }>('/api/plugins/uninstall', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId, plugin_id: pluginId }),
    }),

  telegramStatus: (workspaceId: string) =>
    jsonFetch<TelegramStatus>(
      `/api/plugins/telegram/status?workspace_id=${encodeURIComponent(workspaceId)}`,
    ),

  telegramConnect: (workspaceId: string, botToken: string) =>
    jsonFetch<{ ok: true; bot: { id: number; username: string | null; firstName: string | null }; webhookUrl: string }>(
      '/api/plugins/telegram/connect',
      { method: 'POST', body: JSON.stringify({ workspace_id: workspaceId, bot_token: botToken }) },
    ),

  telegramDiagnostics: (workspaceId: string) =>
    jsonFetch<Record<string, unknown>>('/api/plugins/telegram/diagnostics', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId }),
    }),

  updateSettings: (workspaceId: string, pluginId: string, settings: Record<string, unknown>) =>
    jsonFetch<{ ok: true }>('/api/plugins/settings', {
      method: 'PUT',
      body: JSON.stringify({ workspace_id: workspaceId, plugin_id: pluginId, settings }),
    }),
};

export interface AdminPluginItem extends Omit<PluginCatalogItem, 'planAllowed' | 'installed' | 'installationStatus' | 'installationId'> {
  policy: Record<string, unknown>;
}

export const adminPluginsApi = {
  list: () => jsonFetch<{ items: AdminPluginItem[] }>('/api/plugins/admin'),
  update: (
    pluginId: string,
    patch: Partial<{
      enabled: boolean;
      marketplace_visible: boolean;
      installable: boolean;
      maintenance_mode: boolean;
      featured: boolean;
      sort_order: number;
      rollout_status: PluginRolloutStatus;
    }>,
  ) =>
    jsonFetch<{ state: unknown }>(`/api/plugins/admin/${encodeURIComponent(pluginId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
};
