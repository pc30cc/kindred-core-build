/**
 * E12 — Workspace-safe AI Agent capability snapshot.
 * Reads /api/ai-agent/capabilities which is reachable even when the
 * platform kill switch is on (so the UI can show a disabled state).
 */
import { useQuery } from '@tanstack/react-query';
import { aiAgentApi, type AiAgentCapabilities } from '@/lib/ai-agent-api';

const FALLBACK: AiAgentCapabilities = {
  ai_agent_enabled: true,
  customer_ai_agent_visible: true,
  operator_assist_enabled: true,
  auto_answer_enabled: true,
  learning_enabled: true,
  files_enabled: true,
  websites_enabled: true,
  qna_enabled: true,
  kb_enabled: true,
  customer_nav: {
    overview: true,
    knowledge: true,
    behavior: true,
    operatorAssist: true,
    activity: true,
    settings: true,
  },
  advanced: {
    debug_visible: false,
    regression_visible: false,
    source_health_visible: false,
    test_harness_visible: false,
  },
  disabled_message: null,
};

export function useAiAgentCapabilities(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: ['ai-agent-capabilities', workspaceId],
    enabled: !!workspaceId,
    staleTime: 30_000,
    queryFn: async (): Promise<AiAgentCapabilities> => {
      try {
        const { capabilities } = await aiAgentApi.getCapabilities(workspaceId!);
        return capabilities;
      } catch {
        // Fail-open so a broken backend never traps the user out of the UI.
        return FALLBACK;
      }
    },
  });
}

export const AI_AGENT_CAPABILITIES_FALLBACK = FALLBACK;