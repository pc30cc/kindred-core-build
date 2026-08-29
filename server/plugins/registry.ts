/**
 * Canonical first-party plugin catalog.
 *
 * IMMUTABLE technical capabilities live here in source. Operational platform
 * state (enabled / marketplace_visible / installable / maintenance_mode /
 * featured / sort_order / rollout_status) lives in
 * `public.plugin_platform_state`.
 *
 * Plugins are first-party trusted modules shipped by this repository.
 * "Install" means enabling and configuring one of these — users can never
 * upload code, SQL or modules.
 */

export type PluginCategory =
  | 'channels'
  | 'crm'
  | 'commerce'
  | 'automation'
  | 'ai'
  | 'analytics'
  | 'storage'
  | 'developer';

export type PluginStatus = 'available' | 'coming_soon';

export type PluginDefinition = {
  id: string;
  slug: string;
  version: string;
  category: PluginCategory;
  status: PluginStatus;
  capabilities: string[];
  workspaceInstallable: boolean;
  hasSettings: boolean;
  hasSecrets: boolean;
  supportsInbox: boolean;
  supportsAI: boolean;
  supportsMedia: boolean;
  supportsWebhook: boolean;
  /** Entitlement module key checked through the existing capability registry. */
  planModuleKey: string | null;
  /**
   * Channel entitlement key (capability registry group `ns`, e.g. `telegram`).
   * Channel plugins are sold as plan channels, NOT as modules, so this is what
   * the Plans screen actually toggles — gate on it when present.
   */
  planChannelKey: string | null;
};

const comingSoon = (
  id: string,
  category: PluginCategory,
  overrides: Partial<PluginDefinition> = {},
): PluginDefinition => ({
  id,
  slug: id,
  version: '0.0.0',
  category,
  status: 'coming_soon',
  capabilities: [],
  workspaceInstallable: false,
  hasSettings: false,
  hasSecrets: false,
  supportsInbox: false,
  supportsAI: false,
  supportsMedia: false,
  supportsWebhook: false,
  planModuleKey: null,
  planChannelKey: null,
  ...overrides,
});

export const PLUGIN_REGISTRY: readonly PluginDefinition[] = Object.freeze([
  {
    id: 'telegram',
    slug: 'telegram',
    version: '1.0.0',
    category: 'channels',
    status: 'available',
    capabilities: [
      'inbound_text',
      'inbound_media',
      'outbound_text',
      'outbound_media',
      'profile_sync',
      'commands',
      'localized_content',
    ],
    workspaceInstallable: true,
    hasSettings: true,
    hasSecrets: true,
    supportsInbox: true,
    supportsAI: true,
    supportsMedia: true,
    supportsWebhook: true,
    planModuleKey: null,
    planChannelKey: 'telegram',
  },
  {
    // Bale (بله) — Iranian messenger implementing the Telegram Bot API.
    // Same runtime as Telegram; capability differences are declared in
    // `shared/channels/botProviders.ts`.
    id: 'bale',
    slug: 'bale',
    version: '1.0.0',
    category: 'channels',
    status: 'available',
    capabilities: [
      'inbound_text',
      'inbound_media',
      'outbound_text',
      'outbound_media',
      'profile_sync',
      'commands',
      'localized_content',
    ],
    workspaceInstallable: true,
    hasSettings: true,
    hasSecrets: true,
    supportsInbox: true,
    supportsAI: true,
    supportsMedia: true,
    supportsWebhook: true,
    planModuleKey: null,
    planChannelKey: 'bale',
  },
  {
    // Meta WhatsApp Cloud API. Different wire protocol, same channel runtime:
    // the Worker owns the Graph dialect, Core stays provider-neutral.
    id: 'whatsapp',
    slug: 'whatsapp',
    version: '1.0.0',
    category: 'channels',
    status: 'available',
    capabilities: [
      'inbound_text',
      'inbound_media',
      'outbound_text',
      'outbound_media',
      'profile_sync',
      'localized_content',
    ],
    workspaceInstallable: true,
    hasSettings: true,
    hasSecrets: true,
    supportsInbox: true,
    supportsAI: true,
    supportsMedia: true,
    supportsWebhook: true,
    planModuleKey: null,
    planChannelKey: 'whatsapp',
  },
  comingSoon('instagram', 'channels'),
  comingSoon('messenger', 'channels'),
  comingSoon('email', 'channels'),
  comingSoon('slack', 'channels'),
  comingSoon('discord', 'channels'),
  comingSoon('sms', 'channels'),
  comingSoon('shopify', 'commerce'),
  comingSoon('woocommerce', 'commerce'),
  comingSoon('hubspot', 'crm'),
  comingSoon('webhooks', 'developer'),
]);

const BY_ID = new Map(PLUGIN_REGISTRY.map((p) => [p.id, p]));

export function getPluginDefinition(id: string): PluginDefinition | null {
  return BY_ID.get(id) ?? null;
}

export function isKnownPlugin(id: unknown): id is string {
  return typeof id === 'string' && BY_ID.has(id);
}

export const PLUGIN_CATEGORIES: readonly PluginCategory[] = Object.freeze([
  'channels',
  'crm',
  'commerce',
  'automation',
  'ai',
  'analytics',
  'storage',
  'developer',
]);
