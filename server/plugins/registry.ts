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
  {
    // Instagram Messaging via the Meta Messenger Platform. Same Graph host as
    // WhatsApp, different envelope; the Worker owns the dialect.
    id: 'instagram',
    slug: 'instagram',
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
    planChannelKey: 'instagram',
  },
  {
    // X (Twitter) Direct Messages. No push webhook on accessible API tiers,
    // so the Worker keeps the inbox fresh with a self-rescheduling poll loop
    // instead — see `shared/channels/botProviders.ts` (`supportsPolling`).
    id: 'x',
    slug: 'x',
    version: '1.0.0',
    category: 'channels',
    status: 'available',
    capabilities: [
      'inbound_text',
      'inbound_media',
      'outbound_text',
      'outbound_media',
      'localized_content',
    ],
    workspaceInstallable: true,
    hasSettings: true,
    hasSecrets: true,
    supportsInbox: true,
    supportsAI: true,
    supportsMedia: true,
    supportsWebhook: false,
    planModuleKey: null,
    planChannelKey: 'x',
  },
  comingSoon('messenger', 'channels'),
  {
    // Gmail — a real Email Inbox (server/services/email/, src/pages/app/email/),
    // deliberately NOT the unified chat Inbox: `supportsInbox: false` because
    // email never feeds conversations/conversation_messages (see
    // 163_email_inbox.sql's header comment). Connects via OAuth2 browser
    // redirect (server/services/channels/gmail/oauth.ts), not a pasted
    // token, so it has its own /gmail/oauth/start+callback routes instead of
    // the shared botPaths('connect') flow every other channel uses.
    id: 'gmail',
    slug: 'gmail',
    version: '1.0.0',
    category: 'channels',
    status: 'available',
    capabilities: ['inbound_text', 'inbound_media', 'outbound_text', 'outbound_media'],
    workspaceInstallable: true,
    hasSettings: false,
    hasSecrets: true,
    supportsInbox: false,
    supportsAI: false,
    supportsMedia: true,
    supportsWebhook: true,
    planModuleKey: null,
    planChannelKey: 'gmail',
  },
  {
    // Yahoo Mail — feeds the SAME Email Inbox schema/UI as Gmail
    // (email_threads/email_messages/email_attachments), but via IMAP+SMTP
    // XOAUTH2 (server/services/channels/yahoo/, channels/mail/yahoo/)
    // instead of a REST API + Pub/Sub push: Yahoo exposes no equivalent
    // webhook for third-party apps, so inbound is a self-rescheduling IMAP
    // poll (worker/channels/index.ts's `yahoo_poll_inbox`, mirroring
    // `x_poll_dm_events`) rather than a push route.
    id: 'yahoomail',
    slug: 'yahoomail',
    version: '1.0.0',
    category: 'channels',
    status: 'available',
    capabilities: ['inbound_text', 'inbound_media', 'outbound_text', 'outbound_media'],
    workspaceInstallable: true,
    hasSettings: false,
    hasSecrets: true,
    supportsInbox: false,
    supportsAI: false,
    supportsMedia: true,
    supportsWebhook: false,
    planModuleKey: null,
    planChannelKey: 'yahoomail',
  },
  comingSoon('slack', 'channels'),
  comingSoon('discord', 'channels'),
  comingSoon('sms', 'channels'),
  comingSoon('shopify', 'commerce'),
  {
    // WooCommerce — first Commerce Integration Platform connector. The
    // plugin (plugins/webyar-woocommerce/) is a lightweight bridge; all
    // catalog/order intelligence lives in server/services/commerce/**. See
    // docs/commerce/ARCHITECTURE.md.
    id: 'woocommerce',
    slug: 'woocommerce',
    version: '1.0.0',
    category: 'commerce',
    status: 'available',
    capabilities: [
      'store.read',
      'products.read',
      'catalog.export',
      'availability.read',
      'orders.read',
      'tracking.read',
      'customer_context',
      'events.push',
      'widget.bootstrap',
    ],
    workspaceInstallable: true,
    hasSettings: true,
    hasSecrets: true,
    supportsInbox: false,
    supportsAI: true,
    supportsMedia: false,
    supportsWebhook: true,
    planModuleKey: 'commerce',
    planChannelKey: null,
  },
  {
    // WHMCS — billing-system connector. The addon (plugins/webyar-whmcs/) is
    // queried live and read-only; nothing from WHMCS is mirrored into Web
    // Yar. See docs/commerce/WHMCS.md.
    id: 'whmcs',
    slug: 'whmcs',
    version: '1.0.0',
    category: 'commerce',
    status: 'available',
    capabilities: [
      'catalog.read',
      'account.services.read',
      'account.domains.read',
      'account.invoices.read',
      'account.orders.read',
      'account.tickets.read',
      'identity.grant',
      'widget.bootstrap',
    ],
    workspaceInstallable: true,
    hasSettings: true,
    hasSecrets: true,
    supportsInbox: false,
    supportsAI: true,
    supportsMedia: false,
    supportsWebhook: false,
    planModuleKey: 'commerce',
    planChannelKey: null,
  },
  {
    // OpenCart — a DIRECT connector: the store answers each question live
    // through the webyar-opencart extension (plugins/webyar-opencart/); Web
    // Yar keeps no catalogue copy, no sync and no heartbeat for it. See
    // docs/commerce/OPENCART.md.
    id: 'opencart',
    slug: 'opencart',
    version: '1.0.0',
    category: 'commerce',
    status: 'available',
    capabilities: [
      'store.read',
      'products.read',
      'availability.read',
      'reviews.read',
      'orders.read',
      'tracking.read',
      'returns.read',
      'customer_context',
      'widget.bootstrap',
      'search.direct',
    ],
    workspaceInstallable: true,
    hasSettings: true,
    hasSecrets: true,
    supportsInbox: false,
    supportsAI: true,
    supportsMedia: false,
    supportsWebhook: false,
    planModuleKey: 'commerce',
    planChannelKey: null,
  },
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
