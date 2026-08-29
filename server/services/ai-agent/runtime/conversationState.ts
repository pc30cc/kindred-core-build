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
 * Never overwrites unrelated metadata: the merge happens server-side inside
 * `patch_conversation_runtime_flags` (migration 058) under a row lock, so a
 * concurrent `ai_state = needs_human`, `human_takeover_at` or `ai_memory`
 * write can no longer be reverted by a stale whole-document snapshot.
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
  const { error } = await sb.rpc('patch_conversation_runtime_flags', {
    p_conversation_id: conversationId,
    p_workspace_id: null,
    p_patch: {
      greeting_sent: !!patch.greetingSent,
      handoff_sent: !!patch.handoffSent,
      ...(patch.appendTriggerId ? { append_trigger_id: patch.appendTriggerId } : {}),
      ...(patch.appendWorkflowId ? { append_workflow_id: patch.appendWorkflowId } : {}),
      ...(patch.appendRoutingRuleId ? { append_routing_rule_id: patch.appendRoutingRuleId } : {}),
      touch: patch.touch !== false,
    },
  });
  if (!error) return;

  // Fallback for deployments that have not applied migration 058 yet. Still
  // key-scoped: only the runtime-flag keys are written back, via the atomic
  // shallow-merge RPC from migration 057 where available.
  const { data: row } = await sb
    .from('conversations')
    .select('metadata')
    .eq('id', conversationId)
    .maybeSingle();
  const meta: any = (row as any)?.metadata || {};
  const flags: Record<string, unknown> = {};
  if (patch.greetingSent) flags.ai_greeting_sent = true;
  if (patch.handoffSent) flags.ai_handoff_sent = true;
  const appendTo = (key: string, value?: string) => {
    if (!value) return;
    const arr: string[] = Array.isArray(meta[key]) ? [...meta[key]] : [];
    if (!arr.includes(value)) arr.push(value);
    flags[key] = arr;
  };
  appendTo('ai_trigger_executed_ids', patch.appendTriggerId);
  appendTo('ai_workflow_planned_ids', patch.appendWorkflowId);
  appendTo('ai_routing_executed_rule_ids', patch.appendRoutingRuleId);
  if (patch.touch !== false) flags.ai_last_runtime_action_at = new Date().toISOString();

  const { error: rpcErr } = await sb.rpc('patch_conversation_metadata', {
    p_conversation_id: conversationId,
    p_workspace_id: null,
    p_patch: flags,
  });
  if (!rpcErr) return;
  await sb.from('conversations').update({ metadata: { ...meta, ...flags } }).eq('id', conversationId);
}
