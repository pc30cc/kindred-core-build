/**
 * AI Agent — effective visitor-facing mode resolver.
 *
 * A `mode` column value or an `enabled` boolean alone is not the whole
 * story. This is the single place that answers "is the AI actually going
 * to talk to a visitor right now?" by combining every real gate the
 * codebase already enforces separately:
 *   - platform kill switch + auto_answer feature + module entitlement
 *     (isAutoAnswerAllowedForWorkspace)
 *   - workspace-level ai_agent_settings.enabled
 *   - mode must be a real auto-reply mode — 'off' and 'suggest_only' are
 *     never visitor-facing (suggest_only is operator-facing only)
 *   - an AI provider must actually be configured and resolvable
 *
 * Reused by: widget config (suppress prechat / drive AI_CHAT entry),
 * the intro service, and the handoff routing decision.
 */
import type { ServerConfig } from '../../config.js';
import type { AgentSettings } from './settings.js';
import { isAutoAnswerAllowedForWorkspace } from './platformGuards.js';
import { resolveAIConfig } from '../ai/index.js';

export interface EffectiveAiMode {
  /** True only when the AI will actually reply to the visitor unprompted. */
  visitorFacing: boolean;
  reason:
    | 'ok'
    | 'platform_disabled'
    | 'workspace_disabled'
    | 'mode_off'
    | 'mode_suggest_only'
    | 'no_provider';
}

const AUTO_REPLY_MODES = new Set([
  'auto_reply_when_offline',
  'auto_reply_until_human_joins',
  'auto_reply_always',
]);

/**
 * Pure classification of platform-gate + workspace settings, with no I/O —
 * everything that can be decided synchronously once the caller already has
 * the two inputs in hand. Exported so the mode-precedence rules (platform
 * beats workspace, off/suggest_only never visitor-facing) are directly
 * unit-testable without mocking Supabase or the AI provider resolver.
 * The one input this deliberately leaves out is provider configuration —
 * that requires an actual resolveAIConfig() call and is layered on top by
 * resolveEffectiveAiMode below.
 */
export function classifyEffectiveAiMode(
  platformAllowed: boolean,
  settings: Pick<AgentSettings, 'enabled' | 'mode'>,
): Omit<EffectiveAiMode, 'reason'> & { reason: Exclude<EffectiveAiMode['reason'], 'ok' | 'no_provider'> | 'provider_pending' } {
  if (!platformAllowed) {
    return { visitorFacing: false, reason: 'platform_disabled' };
  }
  if (!settings.enabled) {
    return { visitorFacing: false, reason: 'workspace_disabled' };
  }
  if (settings.mode === 'off') {
    return { visitorFacing: false, reason: 'mode_off' };
  }
  if (settings.mode === 'suggest_only') {
    return { visitorFacing: false, reason: 'mode_suggest_only' };
  }
  if (!AUTO_REPLY_MODES.has(settings.mode)) {
    return { visitorFacing: false, reason: 'mode_off' };
  }
  return { visitorFacing: false, reason: 'provider_pending' };
}

/**
 * `settings` is optional — pass it when the caller already loaded
 * ai_agent_settings this request, to avoid a duplicate query.
 */
export async function resolveEffectiveAiMode(
  config: ServerConfig,
  workspaceId: string,
  settings?: Pick<AgentSettings, 'enabled' | 'mode'>,
): Promise<EffectiveAiMode> {
  const platformGate = await isAutoAnswerAllowedForWorkspace(config, workspaceId);

  let s = settings;
  if (!s) {
    const { getOrCreateSettings } = await import('./settings.js');
    s = await getOrCreateSettings(config, workspaceId);
  }

  const classified = classifyEffectiveAiMode(platformGate.allowed === true, s);
  if (classified.reason !== 'provider_pending') {
    return classified as EffectiveAiMode;
  }

  const aiConfig = await resolveAIConfig(config, workspaceId).catch(() => null);
  if (!aiConfig) {
    return { visitorFacing: false, reason: 'no_provider' };
  }

  return { visitorFacing: true, reason: 'ok' };
}
