/**
 * AI Agent — the language the AI writes to the visitor in.
 *
 * `ai_agent_settings.instructions.reply_language` (the "Personality &
 * behavior" page) is one rule for every path that writes to a visitor in the
 * agent's voice: the engine's turn (engine/contextStage.ts, which every
 * reply, handoff line, trigger and workflow message of the turn follows), the
 * greeting (intro.ts), the operator's draft (routes/ai-agent/operatorAssist.ts)
 * and "Say now" (sayNow.ts):
 *
 *   'visitor'            (also when unset) each path keeps its own visitor
 *                        rule, unchanged: the visitor's language among the
 *                        allowed ones for a turn, the widget's language for
 *                        the greeting, and so on.
 *   'workspace_default'  the workspace's default language
 *                        (workspaces.default_locale) when it is an allowed
 *                        one; otherwise the same rule as 'visitor'.
 *
 * "Allowed" never widens: settings.allowed_locales (the allow-list, and only
 * that) ∩ the platform's visitor languages (getPlatformAllowedLocales, the
 * region lock; Iran: Persian only). When the two have nothing in common the
 * platform's list applies, as the engine always did.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import type { ReplyLanguage } from './settings.js';

/** 'fa-IR' → 'fa'; '' for nothing. */
export function baseLocale(v: unknown): string {
  return String(v ?? '').trim().toLowerCase().split(/[-_]/)[0];
}

/** The workspace's reply-language rule; anything but 'workspace_default' is 'visitor'. */
export function resolveReplyLanguage(
  settings: { instructions?: unknown } | null | undefined,
): ReplyLanguage {
  const raw = (settings?.instructions as { reply_language?: unknown } | null | undefined)?.reply_language;
  return raw === 'workspace_default' ? 'workspace_default' : 'visitor';
}

/**
 * The languages the AI may write to this workspace's visitors in:
 * settings.allowed_locales ∩ the platform's, else the platform's.
 */
export function visitorAllowList(
  settingsAllowed: readonly string[] | null | undefined,
  platformAllowed: readonly string[],
): string[] {
  const platform = platformAllowed.map(baseLocale).filter(Boolean);
  const settings = (settingsAllowed || []).map(baseLocale).filter(Boolean);
  const effective = settings.length ? settings.filter((l) => platform.includes(l)) : platform;
  return effective.length ? effective : platform;
}

/**
 * The language a 'workspace_default' workspace writes in, or null when the
 * caller's own visitor rule applies: 'visitor' mode, no default language, or
 * a default the allow-list does not contain (never past the region lock or
 * allowed_locales).
 */
export function pinnedReplyLocale(
  mode: ReplyLanguage,
  workspaceLocale: unknown,
  allowList: readonly string[],
): string | null {
  if (mode !== 'workspace_default') return null;
  const ws = baseLocale(workspaceLocale);
  return ws && allowList.includes(ws) ? ws : null;
}

/** workspaces.default_locale, base tag; '' when unknown. Never throws. */
export async function loadWorkspaceDefaultLocale(
  config: ServerConfig,
  workspaceId: string,
): Promise<string> {
  try {
    const { data } = await getServiceClient(config)
      .from('workspaces')
      .select('default_locale')
      .eq('id', workspaceId)
      .maybeSingle();
    return baseLocale((data as { default_locale?: unknown } | null)?.default_locale);
  } catch {
    return '';
  }
}

/**
 * For the paths outside the engine (greeting, draft, "Say now"): the pinned
 * language when the workspace answers in its default one, else null. Reads
 * the workspace row only in that mode.
 */
export async function workspaceDefaultReplyLocale(
  config: ServerConfig,
  workspaceId: string,
  settings: { instructions?: unknown } | null | undefined,
  allowList: readonly string[],
): Promise<string | null> {
  const mode = resolveReplyLanguage(settings);
  if (mode !== 'workspace_default') return null;
  return pinnedReplyLocale(mode, await loadWorkspaceDefaultLocale(config, workspaceId), allowList);
}
