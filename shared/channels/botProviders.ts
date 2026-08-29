/**
 * BOT PROVIDER DESCRIPTORS — the single source of truth for every
 * Telegram-compatible messaging channel this platform speaks.
 *
 * PURE module: no I/O, no database, no framework imports. It is imported by
 * Core, by the Channels Gateway (which must stay database-free) and by the
 * Channels Worker alike.
 *
 * Bale (بله) implements the Telegram Bot API surface on its own API root, so
 * one runtime drives both providers. Everything that genuinely differs
 * between them lives in this table and NOWHERE else — never branch on a
 * provider id in feature code, read the capability flag instead.
 */

export const BOT_PROVIDER_IDS = ['telegram', 'bale', 'whatsapp', 'instagram'] as const;
export type BotProviderId = (typeof BOT_PROVIDER_IDS)[number];

/**
 * Wire protocol a provider speaks. Everything Core produces is protocol
 * neutral (text + a keyboard description); the Worker translates it into the
 * dialect right before the socket, so no feature code ever branches on ids.
 */
export type BotApiDialect = 'telegram-bot' | 'whatsapp-cloud' | 'instagram-graph';

/** Markup a provider actually renders in a chat bubble. */
export type BotTextFormat = 'html' | 'whatsapp' | 'plain';

export type BotProviderDescriptor = {
  id: BotProviderId;
  label: string;
  /** Wire protocol; selects the Worker-side client implementation. */
  dialect: BotApiDialect;
  /** Graph-style APIs need a version segment; empty for Bot API providers. */
  apiVersion?: string;
  /** Bot API root; the token is appended as `/bot<token>/<method>`. */
  apiRoot: string;
  /** Accepted shape of a bot credential. */
  tokenPattern: RegExp;
  /**
   * Header the provider echoes back with the registered webhook secret.
   * `null` means the provider has no secret-token mechanism, in which case
   * authenticity rests on the unguessable 192-bit public integration id in
   * the webhook path (and the header is verified only when present).
   */
  webhookSecretHeader: string | null;
  /** Whether `setWebhook` accepts a `secret_token` parameter. */
  supportsSecretToken: boolean;
  /** `setWebhook` accepts an `allowed_updates` filter. */
  supportsAllowedUpdates: boolean;
  /** `setMyName` / `setMyDescription` / `setMyShortDescription` exist. */
  supportsBotProfile: boolean;
  /** `setMyCommands` exists (native "Menu" button next to the input). */
  supportsCommands: boolean;
  /** `sendChatAction` exists (native "typing…" bubble). */
  supportsChatAction: boolean;
  /** `getUserProfilePhotos` exists (contact avatar enrichment). */
  supportsUserProfilePhotos: boolean;
  /**
   * `parse_mode: 'HTML'` is honoured. Bale ignores it and shows the raw tags,
   * so text destined for it must be flattened to plain text first.
   */
  supportsHtmlFormatting: boolean;
  /** Markup dialect the provider renders. */
  textFormat: BotTextFormat;
  /**
   * The platform can register the webhook itself (`setWebhook`). WhatsApp
   * Cloud webhooks are configured once in the Meta app dashboard, so the UI
   * must instead SHOW the callback URL and verify token to the operator.
   */
  supportsWebhookRegistration: boolean;
  /** Inline/reply keyboards vs. WhatsApp interactive buttons + list rows. */
  keyboardStyle: 'telegram' | 'whatsapp-interactive' | 'instagram-quick-reply';
  /** Max buttons a single screen may carry (WhatsApp caps hard). */
  maxButtonsPerScreen: number;
  /** Credential shape accepted by the connect endpoint. */
  credentialKind: 'bot_token' | 'whatsapp_cloud' | 'instagram_graph';
  /** Plan channel entitlement key in the capability registry. */
  planChannelKey: string;
  /** Encrypted credential slots in `plugin_secrets`. */
  secretKeys: { live: string; pending: string; previous: string };
};

function secretKeys(provider: BotProviderId) {
  return {
    live: `${provider}_bot_token`,
    pending: `${provider}_bot_token_pending`,
    previous: `${provider}_bot_token_previous`,
  };
}

const DESCRIPTORS: Record<BotProviderId, BotProviderDescriptor> = {
  telegram: {
    id: 'telegram',
    label: 'Telegram',
    dialect: 'telegram-bot',
    apiRoot: 'https://api.telegram.org',
    tokenPattern: /^\d{6,}:[A-Za-z0-9_-]{20,}$/,
    webhookSecretHeader: 'X-Telegram-Bot-Api-Secret-Token',
    supportsSecretToken: true,
    supportsAllowedUpdates: true,
    supportsBotProfile: true,
    supportsCommands: true,
    supportsChatAction: true,
    supportsUserProfilePhotos: true,
    supportsHtmlFormatting: true,
    textFormat: 'html',
    supportsWebhookRegistration: true,
    keyboardStyle: 'telegram',
    maxButtonsPerScreen: 20,
    credentialKind: 'bot_token',
    planChannelKey: 'telegram',
    secretKeys: secretKeys('telegram'),
  },
  bale: {
    id: 'bale',
    label: 'Bale',
    dialect: 'telegram-bot',
    apiRoot: 'https://tapi.bale.ai',
    // Bale issues Telegram-shaped tokens (`<bot_id>:<secret>`).
    tokenPattern: /^\d{6,}:[A-Za-z0-9_-]{20,}$/,
    webhookSecretHeader: null,
    supportsSecretToken: false,
    supportsAllowedUpdates: false,
    supportsBotProfile: false,
    supportsCommands: true,
    supportsChatAction: true,
    supportsUserProfilePhotos: true,
    supportsHtmlFormatting: false,
    textFormat: 'plain',
    supportsWebhookRegistration: true,
    keyboardStyle: 'telegram',
    maxButtonsPerScreen: 20,
    credentialKind: 'bot_token',
    planChannelKey: 'bale',
    secretKeys: secretKeys('bale'),
  },
  whatsapp: {
    id: 'whatsapp',
    label: 'WhatsApp',
    dialect: 'whatsapp-cloud',
    // Meta Graph API. The credential is a JSON envelope (phone number id +
    // permanent access token), so the token pattern below matches JSON.
    apiRoot: 'https://graph.facebook.com',
    apiVersion: 'v21.0',
    tokenPattern: /^\{[\s\S]*"access_token"[\s\S]*\}$/,
    // Meta signs the body with the app secret (X-Hub-Signature-256), which
    // the credential-free Gateway cannot verify. Authenticity therefore rests
    // on the unguessable 192-bit public integration id in the callback path,
    // exactly as for Bale.
    webhookSecretHeader: null,
    supportsSecretToken: false,
    supportsAllowedUpdates: false,
    supportsBotProfile: true,
    supportsCommands: false,
    supportsChatAction: true,
    supportsUserProfilePhotos: false,
    supportsHtmlFormatting: false,
    textFormat: 'whatsapp',
    supportsWebhookRegistration: false,
    keyboardStyle: 'whatsapp-interactive',
    // Cloud API: 3 reply buttons, or 10 rows in a single list section.
    maxButtonsPerScreen: 10,
    credentialKind: 'whatsapp_cloud',
    planChannelKey: 'whatsapp',
    secretKeys: secretKeys('whatsapp'),
  },
  instagram: {
    id: 'instagram',
    label: 'Instagram',
    // Instagram Messaging rides the Meta Messenger Platform: the same Graph
    // host, a different endpoint shape (`recipient`/`message`) and quick
    // replies instead of inline keyboards.
    dialect: 'instagram-graph',
    apiRoot: 'https://graph.facebook.com',
    apiVersion: 'v21.0',
    // Credential envelope: { ig_account_id, access_token, page_id? }.
    tokenPattern: /^\{[\s\S]*"access_token"[\s\S]*\}$/,
    // Meta signs the body with the app secret (X-Hub-Signature-256), which
    // the credential-free Gateway cannot verify; authenticity rests on the
    // unguessable 192-bit public integration id in the callback path.
    webhookSecretHeader: null,
    supportsSecretToken: false,
    supportsAllowedUpdates: false,
    // The IG professional account name/bio are edited in the Instagram app,
    // never through the messaging API.
    supportsBotProfile: false,
    supportsCommands: false,
    // `sender_action: typing_on` exists on the Messenger Platform.
    supportsChatAction: true,
    // `GET /{igsid}?fields=profile_pic` returns the contact avatar.
    supportsUserProfilePhotos: true,
    supportsHtmlFormatting: false,
    textFormat: 'plain',
    // Webhooks are subscribed once in the Meta app dashboard.
    supportsWebhookRegistration: false,
    keyboardStyle: 'instagram-quick-reply',
    // Messenger Platform caps quick replies at 13 per message.
    maxButtonsPerScreen: 13,
    credentialKind: 'instagram_graph',
    planChannelKey: 'instagram',
    secretKeys: secretKeys('instagram'),
  },
};

export function isBotProvider(value: unknown): value is BotProviderId {
  return typeof value === 'string' && (BOT_PROVIDER_IDS as readonly string[]).includes(value);
}

/** Descriptor lookup. Unknown providers are a programming error. */
export function botProvider(provider: string): BotProviderDescriptor {
  const descriptor = DESCRIPTORS[provider as BotProviderId];
  if (!descriptor) throw new Error(`unknown bot provider: ${provider}`);
  return descriptor;
}

/** Descriptor lookup that tolerates unknown ids (returns null). */
export function findBotProvider(provider: string): BotProviderDescriptor | null {
  return DESCRIPTORS[provider as BotProviderId] ?? null;
}

export const BOT_PROVIDERS: readonly BotProviderDescriptor[] = Object.freeze(
  BOT_PROVIDER_IDS.map((id) => DESCRIPTORS[id]),
);

/** Credential slot names for a provider, used by Core and the Worker. */
export function providerSecretKeys(provider: string) {
  return botProvider(provider).secretKeys;
}

/** Decodes the handful of entities our own HTML escaping can produce. */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Bot-API HTML → readable plain text (line breaks and bullets preserved). */
export function botHtmlToPlainText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>(\s*<\/br>)?/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Bot-API HTML → WhatsApp markup (`*bold*`, `_italic_`, `~strike~`).
 * WhatsApp renders no tags at all, but it does render its own light markup,
 * so headings stay visually distinct instead of collapsing into flat text.
 */
export function botHtmlToWhatsAppText(html: string): string {
  const marked = html
    .replace(/<\s*(b|strong)\s*>/gi, '*')
    .replace(/<\s*\/\s*(b|strong)\s*>/gi, '*')
    .replace(/<\s*(i|em)\s*>/gi, '_')
    .replace(/<\s*\/\s*(i|em)\s*>/gi, '_')
    .replace(/<\s*(s|del)\s*>/gi, '~')
    .replace(/<\s*\/\s*(s|del)\s*>/gi, '~')
    .replace(/<\s*code\s*>/gi, '`')
    .replace(/<\s*\/\s*code\s*>/gi, '`');
  return botHtmlToPlainText(marked);
}

/**
 * Adapts generated bot copy to what the target provider can actually render.
 * Providers without HTML support receive flattened text and no `parse_mode`,
 * so tags never leak into the chat.
 */
export function renderBotText<T extends string | undefined>(
  providerId: string,
  text: string,
  parseMode: T,
): { text: string; parseMode: T | undefined } {
  const descriptor = findBotProvider(providerId);
  if (parseMode !== 'HTML' || descriptor?.supportsHtmlFormatting !== false) {
    return { text, parseMode };
  }
  const flattened =
    descriptor?.textFormat === 'whatsapp' ? botHtmlToWhatsAppText(text) : botHtmlToPlainText(text);
  return { text: flattened, parseMode: undefined };
}
