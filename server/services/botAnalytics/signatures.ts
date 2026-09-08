/**
 * Bot user-agent classification — a pure function, matched against a
 * maintained signature table. Same shape as ../webAnalytics/channels.ts:
 * no vendor call, no external lookup, just a heuristic over data already in
 * hand (the User-Agent string from an access-log line).
 *
 * Order matters: patterns are checked top to bottom, first match wins, so
 * more specific signatures (e.g. "GPTBot") must appear before broader
 * catch-alls (e.g. the generic "bot" fallback at the end).
 */

export type BotCategory = 'ai_assistant' | 'search_engine' | 'seo_tool' | 'social' | 'other';

export interface BotSignature {
  pattern: string;
  botName: string;
  category: BotCategory;
}

// ─── AI assistants / LLM crawlers ──────────────────────────────────────────
// Training crawlers and user-triggered "fetch this page" agents run by AI
// products. This is the list customers actually came here to see.
const AI_ASSISTANT_SIGNATURES: BotSignature[] = [
  { pattern: 'gptbot', botName: 'GPTBot', category: 'ai_assistant' },
  { pattern: 'oai-searchbot', botName: 'OAI-SearchBot', category: 'ai_assistant' },
  { pattern: 'chatgpt-user', botName: 'ChatGPT-User', category: 'ai_assistant' },
  { pattern: 'claudebot', botName: 'ClaudeBot', category: 'ai_assistant' },
  { pattern: 'claude-searchbot', botName: 'Claude-SearchBot', category: 'ai_assistant' },
  { pattern: 'claude-user', botName: 'Claude-User', category: 'ai_assistant' },
  { pattern: 'claude-web', botName: 'Claude-Web', category: 'ai_assistant' },
  { pattern: 'anthropic-ai', botName: 'anthropic-ai', category: 'ai_assistant' },
  { pattern: 'perplexity-user', botName: 'Perplexity-User', category: 'ai_assistant' },
  { pattern: 'perplexitybot', botName: 'PerplexityBot', category: 'ai_assistant' },
  { pattern: 'google-extended', botName: 'Google-Extended', category: 'ai_assistant' },
  { pattern: 'googleother', botName: 'GoogleOther', category: 'ai_assistant' },
  { pattern: 'applebot-extended', botName: 'Applebot-Extended', category: 'ai_assistant' },
  { pattern: 'meta-externalagent', botName: 'Meta-ExternalAgent', category: 'ai_assistant' },
  { pattern: 'meta-externalfetcher', botName: 'Meta-ExternalFetcher', category: 'ai_assistant' },
  { pattern: 'ccbot', botName: 'CCBot', category: 'ai_assistant' },
  { pattern: 'bytespider', botName: 'Bytespider', category: 'ai_assistant' },
  { pattern: 'amazonbot', botName: 'Amazonbot', category: 'ai_assistant' },
  { pattern: 'cohere-ai', botName: 'cohere-ai', category: 'ai_assistant' },
  { pattern: 'cohere-training-data-crawler', botName: 'cohere-training-data-crawler', category: 'ai_assistant' },
  { pattern: 'diffbot', botName: 'Diffbot', category: 'ai_assistant' },
  { pattern: 'youbot', botName: 'YouBot', category: 'ai_assistant' },
  { pattern: 'duckassistbot', botName: 'DuckAssistBot', category: 'ai_assistant' },
  { pattern: 'mistralai-user', botName: 'MistralAI-User', category: 'ai_assistant' },
  { pattern: 'kagibot', botName: 'Kagibot', category: 'ai_assistant' },
  { pattern: 'timpibot', botName: 'Timpibot', category: 'ai_assistant' },
  { pattern: 'imagesiftbot', botName: 'ImagesiftBot', category: 'ai_assistant' },
  { pattern: 'omgilibot', botName: 'omgilibot', category: 'ai_assistant' },
  { pattern: 'omgili', botName: 'omgili', category: 'ai_assistant' },
  { pattern: 'webzio-extended', botName: 'Webzio-Extended', category: 'ai_assistant' },
];

// ─── Traditional search engines ────────────────────────────────────────────
const SEARCH_ENGINE_SIGNATURES: BotSignature[] = [
  { pattern: 'googlebot-image', botName: 'Googlebot-Image', category: 'search_engine' },
  { pattern: 'googlebot-news', botName: 'Googlebot-News', category: 'search_engine' },
  { pattern: 'googlebot-video', botName: 'Googlebot-Video', category: 'search_engine' },
  { pattern: 'googlebot', botName: 'Googlebot', category: 'search_engine' },
  { pattern: 'bingpreview', botName: 'BingPreview', category: 'search_engine' },
  { pattern: 'bingbot', botName: 'Bingbot', category: 'search_engine' },
  { pattern: 'slurp', botName: 'Yahoo Slurp', category: 'search_engine' },
  { pattern: 'duckduckbot', botName: 'DuckDuckBot', category: 'search_engine' },
  { pattern: 'baiduspider', botName: 'Baiduspider', category: 'search_engine' },
  { pattern: 'yandexbot', botName: 'YandexBot', category: 'search_engine' },
  { pattern: 'sogou', botName: 'Sogou', category: 'search_engine' },
  { pattern: 'applebot', botName: 'Applebot', category: 'search_engine' },
  { pattern: 'naverbot', botName: 'Naverbot', category: 'search_engine' },
  { pattern: 'seznambot', botName: 'SeznamBot', category: 'search_engine' },
  { pattern: 'coccocbot', botName: 'coccocbot', category: 'search_engine' },
];

// ─── SEO / marketing tool crawlers ─────────────────────────────────────────
const SEO_TOOL_SIGNATURES: BotSignature[] = [
  { pattern: 'ahrefsbot', botName: 'AhrefsBot', category: 'seo_tool' },
  { pattern: 'ahrefssiteaudit', botName: 'AhrefsSiteAudit', category: 'seo_tool' },
  { pattern: 'semrushbot', botName: 'SemrushBot', category: 'seo_tool' },
  { pattern: 'mj12bot', botName: 'MJ12bot', category: 'seo_tool' },
  { pattern: 'dotbot', botName: 'DotBot', category: 'seo_tool' },
  { pattern: 'rogerbot', botName: 'Rogerbot', category: 'seo_tool' },
  { pattern: 'blexbot', botName: 'BLEXBot', category: 'seo_tool' },
  { pattern: 'seokicks', botName: 'SEOkicks', category: 'seo_tool' },
  { pattern: 'dataforseobot', botName: 'DataForSeoBot', category: 'seo_tool' },
  { pattern: 'serpstatbot', botName: 'serpstatbot', category: 'seo_tool' },
  { pattern: 'screaming frog', botName: 'Screaming Frog SEO Spider', category: 'seo_tool' },
];

// ─── Social / link-preview crawlers ────────────────────────────────────────
const SOCIAL_SIGNATURES: BotSignature[] = [
  { pattern: 'facebookexternalhit', botName: 'Facebook', category: 'social' },
  { pattern: 'facebookcatalog', botName: 'Facebook Catalog', category: 'social' },
  { pattern: 'twitterbot', botName: 'Twitterbot', category: 'social' },
  { pattern: 'linkedinbot', botName: 'LinkedInBot', category: 'social' },
  { pattern: 'slackbot', botName: 'Slackbot', category: 'social' },
  { pattern: 'discordbot', botName: 'Discordbot', category: 'social' },
  { pattern: 'whatsapp', botName: 'WhatsApp', category: 'social' },
  { pattern: 'telegrambot', botName: 'TelegramBot', category: 'social' },
  { pattern: 'pinterest', botName: 'Pinterest', category: 'social' },
  { pattern: 'redditbot', botName: 'Redditbot', category: 'social' },
];

const ALL_SIGNATURES: BotSignature[] = [
  ...AI_ASSISTANT_SIGNATURES,
  ...SEARCH_ENGINE_SIGNATURES,
  ...SEO_TOOL_SIGNATURES,
  ...SOCIAL_SIGNATURES,
];

export const BOT_CATEGORY_LABELS: Record<BotCategory, string> = {
  ai_assistant: 'AI Assistant / LLM',
  search_engine: 'Search Engine',
  seo_tool: 'SEO Tool',
  social: 'Social / Link Preview',
  other: 'Other Bot',
};

/**
 * Returns null for a non-bot User-Agent (a real browser) — callers use that
 * to drop the line, since Bot Analytics only ever stores matched bot hits.
 * Falls back to a generic "other" bucket for a UA that self-identifies as a
 * bot/crawler/spider but isn't in the maintained signature list, rather
 * than silently dropping real (if unrecognized) bot traffic.
 */
export function classifyBot(userAgent: string | null | undefined): { botName: string; category: BotCategory } | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  for (const sig of ALL_SIGNATURES) {
    if (ua.includes(sig.pattern)) return { botName: sig.botName, category: sig.category };
  }
  if (/bot|spider|crawler|crawling|slurp/i.test(userAgent)) {
    const nameMatch = /^([a-z0-9._-]+)/i.exec(userAgent.trim());
    return { botName: nameMatch ? nameMatch[1] : 'Unknown bot', category: 'other' };
  }
  return null;
}
