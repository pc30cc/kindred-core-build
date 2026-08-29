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
  planChannelKey: string | null;
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

export type TelegramLocale = 'en' | 'fa' | 'tr';
export type TelegramHandlingMode = 'human_only' | 'ai_first';
export interface TelegramLocaleMessages {
  welcome: string;
  offline: string;
  fallback: string;
  menuTitle: string;
  menuHint: string;
  back: string;
  faqTitle: string;
  faqHint: string;
  faqEmpty: string;
  guidesTitle: string;
  guidesHint: string;
  guidesEmpty: string;
  prev: string;
  next: string;
  deptTitle: string;
  deptHint: string;
  deptConfirmed: string;
  deptChange: string;
  offlineNotice: string;
  offlineLocked: string;
  offlineInputHint: string;
}
export type TelegramCommandLabels = {
  start: string;
  new: string;
  faq: string;
  guides: string;
};
export type TelegramFaqItem = { question: string; answer: string };
export interface TelegramSettings {
  profile: { name: string; shortDescription: string; description: string; photoUrl: string };
  locales: Record<TelegramLocale, TelegramLocaleMessages>;
  commands: TelegramCommandLabels;
  commandLocales: Record<TelegramLocale, TelegramCommandLabels>;
  /** Optional menu entries the bot exposes (FAQ, help articles). */
  menu: {
    faqEnabled: boolean;
    guidesEnabled: boolean;
    /** Reply with the away screen when no operator is online. */
    offlineNoticeEnabled: boolean;
    /** Close writing while offline and the AI is not answering. */
    lockWhenOffline: boolean;
  };
  faq: Record<TelegramLocale, TelegramFaqItem[]>;
  handlingMode: TelegramHandlingMode;
}


export interface TelegramStatus {
  installed: boolean;
  status?: string;
  settings?: TelegramSettings;
  aiAvailable?: boolean;
  aiAgent?: {
    platformAllowed: boolean;
    platformReason: string | null;
    agentEnabled: boolean;
    agentMode: string | null;
  } | null;
  hasToken?: boolean;

  integration?: {
    status: string;
    botUsername: string | null;
    botName: string | null;
    webhookRegisteredAt: string | null;
    webhookVerifiedAt: string | null;
    lastInboundAt: string | null;
    lastOutboundAt: string | null;
    lastErrorCode: string | null;
    lastErrorAt: string | null;
    webhookUrl: string | null;
    /** Cloud API providers (WhatsApp) register the callback themselves. */
    verifyToken?: string | null;
    managesWebhookExternally?: boolean;

  } | null;
}

export interface TelegramProfilePatch {
  name?: string;
  short_description?: string;
  description?: string;
  commands?: { command: string; description: string }[];
}

export interface ChannelIntegrationRow {
  id: string;
  workspace_id: string;
  provider: string;
  status: string;
  username: string | null;
  display_name: string | null;
  external_account_id: string | null;
  webhook_registered_at: string | null;
  webhook_verified_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  created_at: string;
}

export interface PluginLogEntry {
  id: string;
  kind: 'job' | 'inbound';
  provider: string;
  type: string;
  status: string;
  attempts: number | null;
  error: string | null;
  workspaceId: string | null;
  at: string;
}

export interface ChannelsHealth {
  queue: {
    pending: number;
    running: number;
    failed: number;
    oldestPendingAgeSeconds: number | null;
  };
  workers: { worker_id: string; worker_kind: string; last_seen_at: string; code_version: string | null; alive: boolean }[];
  workersAlive: number;
  deadLetters: { id: string; provider: string; job_type: string; attempt_count: number; last_error: string | null; updated_at: string }[];
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

  // Telegram and Bale share one bot implementation; `provider` selects the
  // API namespace (`/api/plugins/bot/:provider/*`).
  telegramStatus: (workspaceId: string, provider = 'telegram') =>
    jsonFetch<TelegramStatus>(
      `/api/plugins/bot/${provider}/status?workspace_id=${encodeURIComponent(workspaceId)}`,
    ),

  telegramConnect: (workspaceId: string, botToken: string, provider = 'telegram') =>
    jsonFetch<{ ok: true; bot: { id: number; username: string | null; firstName: string | null }; webhookUrl: string }>(
      `/api/plugins/bot/${provider}/connect`,
      { method: 'POST', body: JSON.stringify({ workspace_id: workspaceId, bot_token: botToken }) },
    ),

  /**
   * WhatsApp Cloud connects with a phone number id + permanent access token
   * instead of a bot token; the server stores both in the same encrypted slot.
   */
  whatsappConnect: (
    workspaceId: string,
    input: { phoneNumberId: string; accessToken: string; businessAccountId?: string },
  ) =>
    jsonFetch<{ ok: true; bot: { id: number; username: string | null; firstName: string | null }; webhookUrl: string }>(
      '/api/plugins/bot/whatsapp/connect',
      {
        method: 'POST',
        body: JSON.stringify({
          workspace_id: workspaceId,
          phone_number_id: input.phoneNumberId,
          access_token: input.accessToken,
          business_account_id: input.businessAccountId || null,
        }),
      },
    ),

  /**
   * Instagram Messaging connects with the IG professional account id + a
   * long-lived access token; stored in the same encrypted slot.
   */
  instagramConnect: (
    workspaceId: string,
    input: { igAccountId: string; accessToken: string; pageId?: string },
  ) =>
    jsonFetch<{ ok: true; bot: { id: number; username: string | null; firstName: string | null }; webhookUrl: string }>(
      '/api/plugins/bot/instagram/connect',
      {
        method: 'POST',
        body: JSON.stringify({
          workspace_id: workspaceId,
          ig_account_id: input.igAccountId,
          access_token: input.accessToken,
          page_id: input.pageId || null,
        }),
      },
    ),

  telegramDiagnostics: (workspaceId: string, provider = 'telegram') =>
    jsonFetch<Record<string, unknown>>(`/api/plugins/bot/${provider}/diagnostics`, {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId }),
    }),

  telegramReconnect: (workspaceId: string, provider = 'telegram') =>
    jsonFetch<{ ok: true }>(`/api/plugins/bot/${provider}/reconnect`, {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId }),
    }),

  telegramDisconnect: (workspaceId: string, provider = 'telegram') =>
    jsonFetch<{ ok: true }>(`/api/plugins/bot/${provider}/disconnect`, {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId }),
    }),

  telegramProfile: (workspaceId: string, patch: TelegramProfilePatch, provider = 'telegram') =>
    jsonFetch<{ ok: true }>(`/api/plugins/bot/${provider}/profile`, {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId, ...patch }),
    }),

  logs: (workspaceId: string, pluginId: string) =>
    jsonFetch<{ items: PluginLogEntry[] }>(
      `/api/plugins/logs?workspace_id=${encodeURIComponent(workspaceId)}&plugin_id=${encodeURIComponent(pluginId)}`,
    ),

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
      policy: Record<string, unknown>;
    }>,
  ) =>
    jsonFetch<{ state: unknown }>(`/api/plugins/admin/${encodeURIComponent(pluginId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  channelIntegrations: () =>
    jsonFetch<{ items: ChannelIntegrationRow[] }>('/api/plugins/admin/channels/integrations'),

  logs: (pluginId: string) =>
    jsonFetch<{ items: PluginLogEntry[] }>(`/api/plugins/admin/${encodeURIComponent(pluginId)}/logs`),

  channelsHealth: () => jsonFetch<ChannelsHealth>('/api/plugins/admin/channels/health'),

  retryChannelJobs: (jobIds: string[]) =>
    jsonFetch<{ ok: true; requeued: number }>('/api/plugins/admin/channels/jobs/retry', {
      method: 'POST',
      body: JSON.stringify({ job_ids: jobIds }),
    }),

  forceDisconnect: (integrationId: string) =>
    jsonFetch<{ ok: true }>(
      `/api/plugins/admin/channels/integrations/${encodeURIComponent(integrationId)}/disconnect`,
      { method: 'POST' },
    ),
};
