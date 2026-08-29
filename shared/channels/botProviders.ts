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

export const BOT_PROVIDER_IDS = ['telegram', 'bale'] as const;
export type BotProviderId = (typeof BOT_PROVIDER_IDS)[number];

export type BotProviderDescriptor = {
  id: BotProviderId;
  label: string;
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
    planChannelKey: 'telegram',
    secretKeys: secretKeys('telegram'),
  },
  bale: {
    id: 'bale',
    label: 'Bale',
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
    planChannelKey: 'bale',
    secretKeys: secretKeys('bale'),
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
  return { text: botHtmlToPlainText(text), parseMode: undefined };
}
