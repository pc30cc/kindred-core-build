/**
 * AI Agent — C2 conversation runtime state extensions.
 *
 * Read/write helpers for the dedup metadata flags introduced in Pass C2:
 *   - ai_trigger_executed_ids
 *   - ai_workflow_planned_ids
 *   - ai_greeting_sent
 *   - ai_handoff_sent
 *   - ai_last_runtime_action_at
 *   - ai_routing_executed_rule_ids
 *
 * Never overwrites unrelated metadata.
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';

export interface RuntimeConvFlags {
  greetingSent: boolean;
  handoffSent: boolean;
  triggerExecutedIds: string[];
  workflowPlannedIds: string[];
  routingExecutedRuleIds: string[];
  lastRuntimeActionAt: string | null;
}

export function readRuntimeFlags(metadata: any): RuntimeConvFlags {
  const m = metadata || {};
  return {
    greetingSent: !!m.ai_greeting_sent,
    handoffSent: !!m.ai_handoff_sent,
    triggerExecutedIds: Array.isArray(m.ai_trigger_executed_ids) ? m.ai_trigger_executed_ids : [],
    workflowPlannedIds: Array.isArray(m.ai_workflow_planned_ids) ? m.ai_workflow_planned_ids : [],
    routingExecutedRuleIds: Array.isArray(m.ai_routing_executed_rule_ids) ? m.ai_routing_executed_rule_ids : [],
    lastRuntimeActionAt: typeof m.ai_last_runtime_action_at === 'string' ? m.ai_last_runtime_action_at : null,
  };
}

export interface RuntimeFlagPatch {
  greetingSent?: boolean;
  handoffSent?: boolean;
  appendTriggerId?: string;
  appendWorkflowId?: string;
  appendRoutingRuleId?: string;
  touch?: boolean;
}

export async function updateRuntimeFlags(
  config: ServerConfig,
  conversationId: string,
  patch: RuntimeFlagPatch,
): Promise<void> {
  if (!conversationId) return;
  const sb = getServiceClient(config);
  const { data: row } = await sb
    .from('conversations')
    .select('metadata')
    .eq('id', conversationId)
    .maybeSingle();
  const meta: any = (row as any)?.metadata || {};
  if (patch.greetingSent) meta.ai_greeting_sent = true;
  if (patch.handoffSent) meta.ai_handoff_sent = true;
  if (patch.appendTriggerId) {
    const arr: string[] = Array.isArray(meta.ai_trigger_executed_ids) ? meta.ai_trigger_executed_ids : [];
    if (!arr.includes(patch.appendTriggerId)) arr.push(patch.appendTriggerId);
    meta.ai_trigger_executed_ids = arr;
  }
  if (patch.appendWorkflowId) {
    const arr: string[] = Array.isArray(meta.ai_workflow_planned_ids) ? meta.ai_workflow_planned_ids : [];
    if (!arr.includes(patch.appendWorkflowId)) arr.push(patch.appendWorkflowId);
    meta.ai_workflow_planned_ids = arr;
  }
  if (patch.appendRoutingRuleId) {
    const arr: string[] = Array.isArray(meta.ai_routing_executed_rule_ids) ? meta.ai_routing_executed_rule_ids : [];
    if (!arr.includes(patch.appendRoutingRuleId)) arr.push(patch.appendRoutingRuleId);
    meta.ai_routing_executed_rule_ids = arr;
  }
  if (patch.touch !== false) meta.ai_last_runtime_action_at = new Date().toISOString();
  await sb.from('conversations').update({ metadata: meta }).eq('id', conversationId);
}