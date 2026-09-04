/**
 * AI Proactive Nudge — effective policy resolver.
 *
 * Combines, in the same "platform ceiling ALWAYS clamps workspace config"
 * shape as server/services/ai-agent/platformSettings.ts's
 * getWorkspaceAiAgentCapabilities() and server/services/realtime/
 * effectivePolicy.ts's resolveEffectivePolicy(): the Super Admin singleton
 * (platform_ai_agent_settings), the workspace's own widget_ai_nudge_settings
 * row, the ai_proactive_nudge/widget_smart_engagement plan entitlements, and
 * the SAME visitor-facing AI Agent availability gate the chat itself uses.
 *
 * Never throws — any failure resolves to a safe "disabled" policy so a
 * broken lookup can only ever suppress nudges, never crash the widget.
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { getPlatformAiAgentSettings } from '../../ai-agent/platformSettings.js';
import { isAutoAnswerAllowedForWorkspace } from '../../ai-agent/platformGuards.js';
import { resolveWidgetEntitlements } from '../entitlements.js';
import { AI_MODE_DEFAULTS, type AiProactiveMode } from '../../../../src/lib/widget/smartEngine.js';

export interface WidgetAiNudgeSettingsRow {
  enabled: boolean;
  mode: AiProactiveMode;
  include_paths: string[];
  exclude_paths: string[];
  guidance: string | null;
  use_kb: boolean;
  use_journey: boolean;
  use_returning_visitor: boolean;
  max_per_session: number;
  cooldown_seconds: number;
  stop_after_dismiss: boolean;
  stop_after_widget_open: boolean;
  stop_after_conversation: boolean;
  mobile_enabled: boolean;
}

const ROW_DEFAULTS: WidgetAiNudgeSettingsRow = {
  enabled: false,
  mode: 'balanced',
  include_paths: [],
  exclude_paths: [],
  guidance: null,
  use_kb: true,
  use_journey: true,
  use_returning_visitor: true,
  max_per_session: 2,
  cooldown_seconds: 120,
  stop_after_dismiss: true,
  stop_after_widget_open: true,
  stop_after_conversation: true,
  mobile_enabled: true,
};

export interface EffectiveAiNudgePolicy {
  /** Whether AI proactive nudges may run at all for this workspace right now. */
  available: boolean;
  /** Human-readable reason when `available` is false — for logs, never shown to visitors. */
  unavailableReason: string | null;
  mode: AiProactiveMode;
  includePaths: string[];
  excludePaths: string[];
  guidance: string | null;
  useKb: boolean;
  useJourney: boolean;
  useReturningVisitor: boolean;
  maxPerSession: number;
  cooldownSeconds: number;
  stopAfterDismiss: boolean;
  stopAfterWidgetOpen: boolean;
  stopAfterConversation: boolean;
  mobileEnabled: boolean;
  maxEvaluationsPerSession: number;
  maxMessageLength: number;
  minConfidenceFloor: number;
}

const SAFE_DISABLED: EffectiveAiNudgePolicy = {
  available: false,
  unavailableReason: 'unresolved',
  mode: 'off',
  includePaths: [],
  excludePaths: [],
  guidance: null,
  useKb: true,
  useJourney: true,
  useReturningVisitor: true,
  maxPerSession: 0,
  cooldownSeconds: 3600,
  stopAfterDismiss: true,
  stopAfterWidgetOpen: true,
  stopAfterConversation: true,
  mobileEnabled: false,
  maxEvaluationsPerSession: 0,
  maxMessageLength: 200,
  minConfidenceFloor: 1,
};

export async function getWidgetAiNudgeSettings(config: ServerConfig, workspaceId: string): Promise<WidgetAiNudgeSettingsRow> {
  try {
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('widget_ai_nudge_settings' as any)
      .select('*')
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (!data) return ROW_DEFAULTS;
    return { ...ROW_DEFAULTS, ...(data as any) };
  } catch {
    return ROW_DEFAULTS;
  }
}

function clampInt(value: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export async function resolveEffectiveAiNudgePolicy(
  config: ServerConfig,
  workspaceId: string,
): Promise<EffectiveAiNudgePolicy> {
  try {
    const [platform, row, entitlements, aiGate] = await Promise.all([
      getPlatformAiAgentSettings(config),
      getWidgetAiNudgeSettings(config, workspaceId),
      resolveWidgetEntitlements(config, workspaceId),
      isAutoAnswerAllowedForWorkspace(config, workspaceId),
    ]);

    if (platform.ai_proactive_nudge_enabled !== true) {
      return { ...SAFE_DISABLED, unavailableReason: 'platform_disabled' };
    }
    if (!entitlements.features.widget_smart_engagement) {
      return { ...SAFE_DISABLED, unavailableReason: 'smart_engagement_not_entitled' };
    }
    if (!entitlements.features.ai_proactive_nudge) {
      return { ...SAFE_DISABLED, unavailableReason: 'not_entitled' };
    }
    if (aiGate.allowed !== true) {
      return { ...SAFE_DISABLED, unavailableReason: `ai_agent_unavailable:${(aiGate as any).reason || 'unknown'}` };
    }
    if (!row.enabled || row.mode === 'off') {
      return { ...SAFE_DISABLED, unavailableReason: 'workspace_disabled' };
    }

    const mode = row.mode;
    const modeDefaults = AI_MODE_DEFAULTS[mode as Exclude<AiProactiveMode, 'off'>] || AI_MODE_DEFAULTS.balanced;

    // Platform ceilings ALWAYS win — a workspace can only ever be MORE
    // conservative than the ceiling, never less.
    const maxPerSession = clampInt(
      Math.min(row.max_per_session ?? modeDefaults.maxPerSession, platform.ai_proactive_max_per_session_ceiling),
      0,
      platform.ai_proactive_max_per_session_ceiling,
    );
    const cooldownSeconds = Math.max(
      row.cooldown_seconds ?? modeDefaults.cooldownSeconds,
      platform.ai_proactive_min_cooldown_seconds_ceiling,
    );
    const maxMessageLength = Math.max(40, Math.min(400, platform.ai_proactive_max_message_length));
    const minConfidenceFloor = Math.min(1, Math.max(0, platform.ai_proactive_min_confidence_floor));

    return {
      available: true,
      unavailableReason: null,
      mode,
      includePaths: (row.include_paths || []).slice(0, 50),
      excludePaths: (row.exclude_paths || []).slice(0, 50),
      guidance: row.guidance ? String(row.guidance).slice(0, 500) : null,
      useKb: row.use_kb !== false,
      useJourney: row.use_journey !== false,
      useReturningVisitor: row.use_returning_visitor !== false,
      maxPerSession,
      cooldownSeconds,
      stopAfterDismiss: row.stop_after_dismiss !== false,
      stopAfterWidgetOpen: row.stop_after_widget_open !== false,
      stopAfterConversation: row.stop_after_conversation !== false,
      mobileEnabled: row.mobile_enabled !== false,
      maxEvaluationsPerSession: platform.ai_proactive_max_evaluations_per_session_ceiling,
      maxMessageLength,
      minConfidenceFloor,
    };
  } catch {
    return SAFE_DISABLED;
  }
}
