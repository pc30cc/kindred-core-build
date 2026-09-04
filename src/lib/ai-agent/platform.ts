/**
 * AI Agent API client — platform domain.
 *
 * Mechanically extracted from src/lib/ai-agent-api.ts (Phase 4 split).
 * Super-admin-only settings (backend admin guard enforced). Same URLs,
 * methods, bodies, and response types as before.
 */
import { jsonFetch } from './client.js';


// E12 — Platform AI Agent (Super Admin) settings.
export interface PlatformAiAgentSettings {
  id: string;
  ai_agent_enabled: boolean;
  customer_ai_agent_visible: boolean;
  advanced_tools_enabled: boolean;
  regression_runner_enabled: boolean;
  source_health_visible_to_customers: boolean;
  test_harness_visible_to_customers: boolean;
  operator_assist_enabled: boolean;
  auto_answer_enabled: boolean;
  learning_enabled: boolean;
  files_enabled: boolean;
  websites_enabled: boolean;
  qna_enabled: boolean;
  kb_enabled: boolean;
  max_customer_visible_nav_items: number;
  disabled_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  /** AI Proactive Nudge — hard platform ceilings. Always dominate workspace config. */
  ai_proactive_nudge_enabled: boolean;
  ai_proactive_default_mode: 'off' | 'conservative' | 'balanced' | 'active';
  ai_proactive_max_per_session_ceiling: number;
  ai_proactive_min_cooldown_seconds_ceiling: number;
  ai_proactive_max_evaluations_per_session_ceiling: number;
  ai_proactive_max_message_length: number;
  ai_proactive_min_confidence_floor: number;
}


export interface PlatformAiProactiveStats {
  workspacesUsing: number;
  counters: { shown: number; dismissed: number; cta_clicked: number; widget_opened: number; conversation_started: number };
  aiUsage: { costUsd: number; chargeIrr: number; runs: number };
  last24h: {
    evaluated: number; suppressed: number; shown: number;
    timeout: number; invalid_response: number; billing_denied: number; provider_unavailable: number;
  };
}

export const platformApi = {
  // E12 — Super Admin only (backend admin guard enforced)
  getPlatformSettings: () =>
    jsonFetch(`/api/ai-agent/platform/settings`) as Promise<{ settings: PlatformAiAgentSettings }>,
  updatePlatformSettings: (patch: Partial<PlatformAiAgentSettings>) =>
    jsonFetch(`/api/ai-agent/platform/settings`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }) as Promise<{ settings: PlatformAiAgentSettings }>,
  getAiProactiveStats: () =>
    jsonFetch(`/api/ai-agent/platform/ai-proactive-stats`) as Promise<PlatformAiProactiveStats>,
};
