/**
 * E12 — Workspace-safe AI Agent capability snapshot.
 * Reads /api/ai-agent/capabilities which is reachable even when the
 * platform kill switch is on (so the UI can show a disabled state).
 */
import { useQuery } from '@tanstack/react-query';
import { aiAgentApi, type AiAgentCapabilities } from '@/lib/ai-agent-api';

/**
 * Fail-closed safe snapshot. Used only when we have NO information yet
 * (initial mount). On error, do NOT pretend the platform is enabled.
 */
const DISABLED_SAFE: AiAgentCapabilities = {
  ai_agent_enabled: false,
  customer_ai_agent_visible: false,
  operator_assist_enabled: false,
  auto_answer_enabled: false,
  learning_enabled: false,
  files_enabled: false,
  websites_enabled: false,
  qna_enabled: false,
  kb_enabled: false,
  customer_nav: {
    overview: false,
    knowledge: false,
    behavior: false,
    operatorAssist: false,
    activity: false,
    settings: false,
  },
  advanced: {
    debug_visible: false,
    regression_visible: false,
    source_health_visible: false,
    test_harness_visible: false,
  },
  disabled_message: null,
};

/**
 * E12-Fix Phase 5 — fail-CLOSED capability snapshot.
 * On error: throw → callers must handle isError separately and hide UI.
 * Never returns an "enabled" guess to the UI.
 */
export function useAiAgentCapabilities(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: ['ai-agent-capabilities', workspaceId],
    enabled: !!workspaceId,
    staleTime: 30_000,
    retry: 1,
    queryFn: async (): Promise<AiAgentCapabilities> => {
      const { capabilities } = await aiAgentApi.getCapabilities(workspaceId!);
      return capabilities;
    },
  });
}

export const AI_AGENT_CAPABILITIES_DISABLED_SAFE = DISABLED_SAFE;