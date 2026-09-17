/**
 * AI AGENT — the single choke point for `ai_agent_debug_events` writes.
 *
 * Three producers (the operator "inspect this answer" view, the internal QA
 * retrieval-debug run and the scheduled regression runner's failed-batch
 * notice) each recorded their own best-effort observability event. They are
 * a developer/operator debugging aid: no visitor path reads them, nothing
 * branches on them, and no alert or webhook fires from them.
 *
 * Gated by PRODUCT_ANALYTICS_LOGGING; see server/config.ts.
 */
import type { ServerConfig } from '../../config.js';
import type { ServiceClient } from '../../supabase.js';

export interface AiAgentDebugEventInput {
  workspaceId: string;
  eventType: string;
  runId?: string | null;
  actorUserId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Best-effort: never throws. No-op when PRODUCT_ANALYTICS_LOGGING=off. */
export async function recordAiAgentDebugEvent(
  config: ServerConfig,
  sb: ServiceClient,
  input: AiAgentDebugEventInput,
): Promise<void> {
  if (config.productAnalyticsLoggingEnabled === false) return;
  try {
    await sb.from('ai_agent_debug_events').insert({
      workspace_id: input.workspaceId,
      run_id: input.runId ?? null,
      event_type: input.eventType,
      actor_user_id: input.actorUserId ?? null,
      metadata: input.metadata ?? {},
    });
  } catch { /* noop */ }
}
