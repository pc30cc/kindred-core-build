/**
 * P0-AI — the ONE authoritative "what may a visitor be told about the AI"
 * snapshot.
 *
 * Before this module every visitor-facing surface re-derived AI state from
 * a different subset of the gates, and `/widget/config` in particular
 * treated `provider_pending` (all gates passed EXCEPT a resolvable AI
 * provider) as if the AI were fully visitor-facing — so it suppressed the
 * generic greeting for workspaces whose AI could never answer.
 *
 * The two questions are genuinely different and are now answered
 * separately, from one place:
 *
 *   introCapable  — may the AI speak FIRST? The intro is static/templated
 *                   (see intro.ts — it never calls resolveAIConfig), so it
 *                   needs the platform gate + workspace toggle + an
 *                   auto-reply mode, but NOT a provider.
 *   visitorFacing — will the AI actually CONVERSE with the visitor? This
 *                   additionally requires a resolvable provider, because
 *                   without one every follow-up message goes unanswered.
 *
 * Greeting suppression / prechat-skip must key off `visitorFacing`: those
 * decisions promise the visitor a conversation, not a single canned line.
 *
 * SECURITY: this snapshot is serialized to an unauthenticated widget
 * bootstrap. It carries booleans, the mode string and a coarse reason code
 * ONLY — never provider names, endpoints, model ids, keys or any other
 * credential-adjacent value.
 */
import type { ServerConfig } from '../../config.js';
import type { AgentSettings } from './settings.js';
import { classifyEffectiveAiMode, resolveEffectiveAiMode, type EffectiveAiMode } from './effectiveMode.js';
import { isAutoAnswerAllowedForWorkspace } from './platformGuards.js';

export interface VisitorAiSnapshot {
  /** Platform kill switch + customer visibility + auto_answer + plan module. */
  platformAllowed: boolean;
  /** ai_agent_settings.enabled */
  workspaceEnabled: boolean;
  mode: string;
  /** mode is one of the real auto-reply modes (never off/suggest_only). */
  autoReplyMode: boolean;
  /** An AI provider is configured and resolvable for this workspace. */
  providerReady: boolean;
  /** AI will actually converse with the visitor. Requires providerReady. */
  visitorFacing: boolean;
  /** AI may send the static intro first. Does NOT require providerReady. */
  introCapable: boolean;
  /** Coarse, non-sensitive diagnosis. */
  reason: EffectiveAiMode['reason'];
}

export const VISITOR_AI_SNAPSHOT_OFF: VisitorAiSnapshot = {
  platformAllowed: false,
  workspaceEnabled: false,
  mode: 'off',
  autoReplyMode: false,
  providerReady: false,
  visitorFacing: false,
  introCapable: false,
  reason: 'platform_disabled',
};

/**
 * `settings` is optional — pass it when the caller already loaded
 * ai_agent_settings this request to avoid a duplicate query.
 *
 * Fail-closed: any unexpected error yields the all-off snapshot.
 */
export async function resolveVisitorAiSnapshot(
  config: ServerConfig,
  workspaceId: string,
  settings?: Pick<AgentSettings, 'enabled' | 'mode'>,
): Promise<VisitorAiSnapshot> {
  try {
    const platformGate = await isAutoAnswerAllowedForWorkspace(config, workspaceId);
    const platformAllowed = platformGate.allowed === true;

    let s = settings;
    if (!s) {
      const { getOrCreateSettings } = await import('./settings.js');
      s = await getOrCreateSettings(config, workspaceId);
    }

    const classified = classifyEffectiveAiMode(platformAllowed, s);
    const base = {
      platformAllowed,
      workspaceEnabled: !!s.enabled,
      mode: String(s.mode || 'off'),
    };

    if (classified.reason !== 'provider_pending') {
      return {
        ...base,
        autoReplyMode: false,
        providerReady: false,
        visitorFacing: false,
        introCapable: false,
        reason: classified.reason as EffectiveAiMode['reason'],
      };
    }

    // Every non-provider gate passed → the static intro is allowed. Only the
    // provider check decides whether a real conversation can follow.
    const effective = await resolveEffectiveAiMode(config, workspaceId, s);
    const providerReady = effective.visitorFacing === true;
    return {
      ...base,
      autoReplyMode: true,
      providerReady,
      visitorFacing: providerReady,
      introCapable: true,
      reason: effective.reason,
    };
  } catch {
    return { ...VISITOR_AI_SNAPSHOT_OFF, reason: 'platform_disabled' };
  }
}
